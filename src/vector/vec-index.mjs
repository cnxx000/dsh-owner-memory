import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { eventSearchText } from '../indexer.js';
import { encodeVectors } from './client.mjs';
import {
  EVENT_SEARCH_TEXT_VERSION,
  MODEL_ID,
  MODEL_REV,
  QUERY_PREFIX,
  VECTOR_DIM,
  VECTOR_FORMAT,
} from './constants.mjs';
import {
  FLOOR_CALIBRATION_METHOD,
  FLOOR_CALIBRATION_QUERIES,
  FLOOR_CALIBRATION_SHA256,
  FLOOR_CALIBRATION_VERSION,
  FLOOR_MAX,
  FLOOR_MIN,
} from './floor-calibration.mjs';

const QUANTIZATION_SCALE = 127;
const BATCH_SIZE = 16;
const backgroundBuilds = new Map();

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

async function readSource(root) {
  const bytes = await fs.readFile(path.join(root, 'events.jsonl'));
  const events = bytes.toString('utf8')
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`invalid events.jsonl line ${index + 1}: ${error.message}`);
      }
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  return { bytes, events, hash: sha256(bytes) };
}

function baseMetadataMatches(metadata, source) {
  return metadata?.format === VECTOR_FORMAT
    && metadata.model === MODEL_ID
    && metadata.rev === MODEL_REV
    && metadata.dim === VECTOR_DIM
    && metadata.prefix === QUERY_PREFIX
    && metadata.eventSearchText?.version === EVENT_SEARCH_TEXT_VERSION
    && metadata.quantization?.type === 'int8'
    && metadata.quantization?.scale === QUANTIZATION_SCALE
    && metadata.source?.sha256 === source.hash
    && metadata.source?.events === source.events.length
    && Array.isArray(metadata.ids)
    && metadata.ids.length === source.events.length
    && metadata.ids.every((id, index) => id === source.events[index].id);
}

function floorCalibrationMatches(metadata) {
  return Number.isFinite(metadata?.cosineFloorP90)
    && metadata.floorCalibration?.queries === FLOOR_CALIBRATION_QUERIES.length
    && metadata.floorCalibration?.method === FLOOR_CALIBRATION_METHOD
    && metadata.floorCalibration?.version === FLOOR_CALIBRATION_VERSION
    && metadata.floorCalibration?.sha256 === FLOOR_CALIBRATION_SHA256;
}

function metadataMatches(metadata, source) {
  return baseMetadataMatches(metadata, source) && floorCalibrationMatches(metadata);
}

function quantize(vectors, dim) {
  const output = new Int8Array(vectors.length * dim);
  vectors.forEach(({ vec }, row) => {
    if (!(vec instanceof Float32Array) || vec.length !== dim) {
      throw new Error(`unexpected vector dimension: ${vec?.length ?? 'missing'}, expected ${dim}`);
    }
    const offset = row * dim;
    for (let column = 0; column < dim; column += 1) {
      output[offset + column] = Math.max(
        -127,
        Math.min(127, Math.round(vec[column] * QUANTIZATION_SCALE)),
      );
    }
  });
  return output;
}

async function readVecFiles(root) {
  let metadata;
  let binary;
  try {
    [metadata, binary] = await Promise.all([
      fs.readFile(path.join(root, 'vec.json'), 'utf8').then(JSON.parse),
      fs.readFile(path.join(root, 'vec.bin')),
    ]);
  } catch (error) {
    if (error?.code === 'ENOENT') return { status: 'missing' };
    if (error instanceof SyntaxError) return { status: 'invalid', reason: error.message };
    throw error;
  }
  if (!Array.isArray(metadata?.ids) || !Number.isInteger(metadata?.dim)) {
    return { status: 'invalid', reason: 'invalid vec.json metadata' };
  }
  if (binary.byteLength !== metadata.ids.length * metadata.dim) {
    return { status: 'invalid', reason: 'vec.bin size mismatch' };
  }
  if (sha256(binary) !== metadata.files?.vecBinSha256) {
    return { status: 'invalid', reason: 'vec.bin hash mismatch' };
  }
  return {
    status: 'loaded',
    index: {
      metadata,
      data: new Int8Array(binary.buffer, binary.byteOffset, binary.byteLength),
    },
  };
}

export async function inspectVecIndex(root) {
  const loaded = await readVecFiles(root);
  if (loaded.status !== 'loaded') return loaded;
  const source = await readSource(root);
  if (!metadataMatches(loaded.index.metadata, source)) {
    return { status: 'stale', index: loaded.index };
  }
  return { status: 'current', index: loaded.index };
}

export async function loadVecIndex(root, { validateSource = true } = {}) {
  if (!validateSource) {
    const loaded = await readVecFiles(root);
    return loaded.status === 'loaded' ? loaded.index : null;
  }
  const inspected = await inspectVecIndex(root);
  return inspected.status === 'current' ? inspected.index : null;
}

export async function buildVecIndex(root, { encode = encodeVectors } = {}) {
  const source = await readSource(root);
  const loaded = await readVecFiles(root);
  if (loaded.status === 'loaded' && metadataMatches(loaded.index.metadata, source)) {
    return loaded.index;
  }

  let index;
  let binary;
  if (loaded.status === 'loaded' && baseMetadataMatches(loaded.index.metadata, source)) {
    index = loaded.index;
    index.metadata = structuredClone(index.metadata);
  } else {
    const vectors = [];
    const texts = source.events.map(eventSearchText);
    for (let start = 0; start < texts.length; start += BATCH_SIZE) {
      const encoded = await encode(texts.slice(start, start + BATCH_SIZE), { query: false });
      if (encoded === null) return null;
      vectors.push(...encoded);
    }
    if (vectors.length !== source.events.length) {
      throw new Error(`encoder returned ${vectors.length} rows for ${source.events.length} events`);
    }

    const dim = vectors[0]?.dim ?? VECTOR_DIM;
    if (dim !== VECTOR_DIM) throw new Error(`model dimension ${dim}, expected ${VECTOR_DIM}`);
    const data = quantize(vectors, dim);
    binary = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    index = {
      data,
      metadata: {
        format: VECTOR_FORMAT,
        model: MODEL_ID,
        rev: MODEL_REV,
        dim,
        prefix: QUERY_PREFIX,
        eventSearchText: { version: EVENT_SEARCH_TEXT_VERSION },
        quantization: { type: 'int8', scale: QUANTIZATION_SCALE, normalized: true },
        source: { file: 'events.jsonl', events: source.events.length, sha256: source.hash },
        ids: source.events.map(({ id }) => id),
        files: { vecBinSha256: sha256(binary) },
      },
    };
  }

  const calibration = await calibrateCosineFloor(index, { encode });
  if (!calibration) return null;
  index.metadata.cosineFloorP90 = calibration.floor;
  index.metadata.floorCalibration = {
    queries: FLOOR_CALIBRATION_QUERIES.length,
    method: FLOOR_CALIBRATION_METHOD,
    version: FLOOR_CALIBRATION_VERSION,
    sha256: FLOOR_CALIBRATION_SHA256,
  };
  delete index.metadata.floor_clamped;
  if (calibration.clamped) {
    index.metadata.floor_clamped = {
      raw: calibration.raw,
      value: calibration.floor,
      min: FLOOR_MIN,
      max: FLOOR_MAX,
    };
  }

  if (binary) await fs.writeFile(path.join(root, 'vec.bin'), binary);
  await fs.writeFile(path.join(root, 'vec.json'), `${JSON.stringify(index.metadata, null, 2)}\n`);
  return index;
}

function rowCosine(data, leftOffset, right, rightOffset, dim) {
  let dot = 0;
  let leftSquared = 0;
  let rightSquared = 0;
  for (let column = 0; column < dim; column += 1) {
    const left = data[leftOffset + column];
    const rightValue = right[rightOffset + column];
    dot += left * rightValue;
    leftSquared += left * left;
    rightSquared += rightValue * rightValue;
  }
  const denominator = Math.sqrt(leftSquared * rightSquared);
  return denominator === 0 ? 0 : dot / denominator;
}

function percentile90(values) {
  if (values.length === 0) return 0;
  values.sort((left, right) => left - right);
  return values[Math.max(0, Math.ceil(values.length * 0.9) - 1)];
}

export function docPairP90(index) {
  const { metadata, data } = index;
  const values = [];
  for (let left = 0; left < metadata.ids.length; left += 1) {
    for (let right = left + 1; right < metadata.ids.length; right += 1) {
      values.push(rowCosine(
        data,
        left * metadata.dim,
        data,
        right * metadata.dim,
        metadata.dim,
      ));
    }
  }
  return percentile90(values);
}

export async function calibrateCosineFloor(index, { encode = encodeVectors } = {}) {
  const values = [];
  for (let start = 0; start < FLOOR_CALIBRATION_QUERIES.length; start += BATCH_SIZE) {
    const encoded = await encode(
      FLOOR_CALIBRATION_QUERIES.slice(start, start + BATCH_SIZE),
      { query: true },
    );
    if (encoded === null) return null;
    for (const queryVector of encoded) {
      values.push(...Object.values(cosineById(index, queryVector)));
    }
  }
  const raw = percentile90(values);
  const floor = Math.max(FLOOR_MIN, Math.min(FLOOR_MAX, raw));
  return { raw, floor, clamped: floor !== raw };
}

export function cosineById(index, queryVector) {
  const { metadata, data } = index;
  const vector = queryVector?.vec ?? queryVector;
  if (!(vector instanceof Float32Array) || vector.length !== metadata.dim) {
    throw new Error(`query dimension ${vector?.length ?? 'missing'}, expected ${metadata.dim}`);
  }

  return Object.fromEntries(metadata.ids.map((id, row) => {
    const offset = row * metadata.dim;
    let dot = 0;
    let rowSquared = 0;
    for (let column = 0; column < metadata.dim; column += 1) {
      const value = data[offset + column];
      dot += vector[column] * value;
      rowSquared += value * value;
    }
    return [id, rowSquared === 0 ? 0 : dot / Math.sqrt(rowSquared)];
  }));
}

export function rankVecIndex(index, queryVector, limit = 5) {
  const scored = Object.entries(cosineById(index, queryVector))
    .map(([id, cosine]) => ({ id, cosine }));
  scored.sort((left, right) => right.cosine - left.cosine || left.id.localeCompare(right.id));
  return scored.slice(0, Math.max(0, limit));
}

export function scheduleVecIndexBuild(root, options = {}) {
  if (backgroundBuilds.has(root)) return backgroundBuilds.get(root);
  const task = new Promise((resolve) => setImmediate(resolve))
    .then(() => buildVecIndex(root, options))
    .catch((error) => {
      options.onError?.(error);
      return null;
    })
    .finally(() => backgroundBuilds.delete(root));
  backgroundBuilds.set(root, task);
  return task;
}
