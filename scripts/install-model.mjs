#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MODEL_FILES,
  MODEL_ID,
  MODEL_REV,
  modelDirectory,
  modelFileUrl,
} from '../src/vector/constants.mjs';

async function fileDigest(file) {
  const bytes = await fs.readFile(file);
  return {
    bytes: bytes.byteLength,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  };
}

async function verifyFile(root, expected) {
  const file = path.join(root, ...expected.name.split('/'));
  let actual;
  try {
    actual = await fileDigest(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: false, reason: 'missing', file };
    throw error;
  }
  if (actual.bytes !== expected.bytes) {
    return {
      ok: false,
      reason: `size ${actual.bytes}, expected ${expected.bytes}`,
      file,
    };
  }
  if (actual.sha256 !== expected.sha256) {
    return {
      ok: false,
      reason: `sha256 ${actual.sha256}, expected ${expected.sha256}`,
      file,
    };
  }
  return { ok: true, file };
}

async function verifyAll(root, { quiet = false } = {}) {
  const failures = [];
  for (const expected of MODEL_FILES) {
    const result = await verifyFile(root, expected);
    if (!result.ok) failures.push({ name: expected.name, ...result });
    else if (!quiet) console.log(`ok ${expected.name}`);
  }
  return failures;
}

async function downloadFile(root, expected) {
  const target = path.join(root, ...expected.name.split('/'));
  const temporary = `${target}.download`;
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.rm(temporary, { force: true });

  console.log(`download ${expected.name} (${expected.bytes} bytes)`);
  const response = await fetch(modelFileUrl(expected.name), { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`download ${expected.name}: HTTP ${response.status} ${response.statusText}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  await fs.writeFile(temporary, bytes);

  const result = await verifyFile(path.dirname(temporary), {
    ...expected,
    name: path.basename(temporary),
  });
  if (!result.ok) {
    await fs.rm(temporary, { force: true });
    throw new Error(`download ${expected.name}: ${result.reason}`);
  }
  await fs.rename(temporary, target);
}

export async function installModel({ check = false, root = modelDirectory() } = {}) {
  if (check) {
    const failures = await verifyAll(root);
    if (failures.length) {
      const detail = failures.map(({ name, reason }) => `${name}: ${reason}`).join('; ');
      throw new Error(`model check failed at ${root}: ${detail}`);
    }
    console.log(`model_ok: ${root}`);
    return root;
  }

  await fs.mkdir(root, { recursive: true });
  for (const expected of MODEL_FILES) {
    const current = await verifyFile(root, expected);
    if (!current.ok) await downloadFile(root, expected);
  }
  const failures = await verifyAll(root, { quiet: true });
  if (failures.length) throw new Error(`model verification failed: ${failures[0].reason}`);
  console.log(`model_installed: ${MODEL_ID}@${MODEL_REV}`);
  console.log(`model_dir: ${root}`);
  return root;
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const unknown = [...args].filter((arg) => arg !== '--check');
  if (unknown.length) throw new Error(`unknown argument: ${unknown[0]}`);
  await installModel({ check: args.has('--check') });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error?.message ?? String(error));
    process.exitCode = 1;
  });
}
