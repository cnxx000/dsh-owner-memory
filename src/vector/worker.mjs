import fs from 'node:fs/promises';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import {
  MODEL_FILES,
  MODEL_ID,
  QUERY_PREFIX,
  modelDirectory,
} from './constants.mjs';

const BATCH_SIZE = 16;
const VENDOR_DIR = fileURLToPath(new URL('../../vendor/', import.meta.url));
const MODEL_DIR = workerData?.modelDir ?? modelDirectory();

function localModelCache(root) {
  return {
    async match(key) {
      const normalized = decodeURIComponent(String(key)).replaceAll('\\', '/');
      const entry = MODEL_FILES.find(({ name }) => normalized.endsWith(`/${name}`));
      if (!entry) return undefined;
      const bytes = await fs.readFile(path.join(root, ...entry.name.split('/')));
      return new Response(bytes, {
        status: 200,
        headers: { 'content-length': String(bytes.byteLength) },
      });
    },
    async put() {},
  };
}

function normalizedCls(hidden, row) {
  if (!hidden || hidden.dims?.length !== 3) {
    throw new Error(`unexpected model output dims: ${JSON.stringify(hidden?.dims)}`);
  }
  const [, sequenceLength, dim] = hidden.dims;
  const start = row * sequenceLength * dim;
  const source = hidden.data.subarray(start, start + dim);
  let squared = 0;
  for (const value of source) squared += value * value;
  const norm = Math.sqrt(squared);
  if (!Number.isFinite(norm) || norm === 0) throw new Error('model returned a zero vector');
  return {
    dim,
    vec: Float32Array.from(source, (value) => value / norm),
  };
}

function disposeTensors(value) {
  for (const tensor of Object.values(value ?? {})) tensor?.dispose?.();
}

async function createEncoder() {
  // The web bundle expects the Web Worker global during module evaluation. It
  // also branches on `process.release.name`; hide that marker while importing
  // so the browser bundle cannot select its intentionally empty Node external.
  globalThis.self ??= globalThis;
  const nodeProcess = globalThis.process;
  let tokenizer;
  let model;
  try {
    globalThis.process = undefined;
    const { AutoModel, AutoTokenizer, env } = await import('../../vendor/transformers.min.js');

    for (const entry of MODEL_FILES) {
      const file = path.join(MODEL_DIR, ...entry.name.split('/'));
      const stat = await fs.stat(file).catch((error) => {
        if (error?.code === 'ENOENT') {
          throw new Error(`model missing: ${file}; run node scripts/install-model.mjs`);
        }
        throw error;
      });
      if (stat.size !== entry.bytes) {
        throw new Error(`model file size mismatch: ${file}`);
      }
    }

    env.allowLocalModels = true;
    env.allowRemoteModels = false;
    env.useBrowserCache = false;
    env.useFSCache = false;
    env.useCustomCache = true;
    env.customCache = localModelCache(MODEL_DIR);
    env.backends.onnx.wasm.numThreads = 1;
    env.backends.onnx.wasm.proxy = false;
    const wasmPaths = {};
    for (const name of ['ort-wasm.wasm', 'ort-wasm-simd.wasm']) {
      const bytes = await fs.readFile(path.join(VENDOR_DIR, name));
      wasmPaths[name] = `data:application/wasm;base64,${bytes.toString('base64')}`;
    }
    env.backends.onnx.wasm.wasmPaths = wasmPaths;

    const options = { local_files_only: true };
    [tokenizer, model] = await Promise.all([
      AutoTokenizer.from_pretrained(MODEL_ID, options),
      AutoModel.from_pretrained(MODEL_ID, {
        ...options,
        quantized: false,
        model_file_name: 'model_int8',
      }),
    ]);
  } finally {
    globalThis.process = nodeProcess;
  }

  return async function encode(texts, { query = false } = {}) {
    const results = [];
    for (let start = 0; start < texts.length; start += BATCH_SIZE) {
      const batch = texts.slice(start, start + BATCH_SIZE)
        .map((text) => (query ? `${QUERY_PREFIX}${text}` : text));
      const inputs = await tokenizer(batch, {
        padding: true,
        truncation: true,
        max_length: 512,
      });
      const output = await model(inputs);
      for (let row = 0; row < batch.length; row += 1) {
        results.push(normalizedCls(output.last_hidden_state, row));
      }
      disposeTensors(output);
      disposeTensors(inputs);
    }
    return results;
  };
}

if (!parentPort) throw new Error('vector worker must run in worker_threads');

let encode;
try {
  encode = await createEncoder();
  parentPort.postMessage({ type: 'ready' });
} catch (error) {
  parentPort.postMessage({ type: 'failed', reason: error?.message ?? String(error) });
}

parentPort.on('message', async (message) => {
  if (!encode || message?.type !== 'encode' || !Array.isArray(message.texts)) return;
  try {
    const results = await encode(message.texts.map(String), { query: message.query === true });
    parentPort.postMessage(results, results.map(({ vec }) => vec.buffer));
  } catch (error) {
    parentPort.postMessage({ type: 'failed', reason: error?.message ?? String(error) });
  }
});
