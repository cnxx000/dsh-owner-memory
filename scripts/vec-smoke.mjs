#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  encodeVectors,
  vectorClient,
  vectorDisabledReason,
} from '../src/vector/client.mjs';
import {
  buildVecIndex,
  loadVecIndex,
  rankVecIndex,
} from '../src/vector/vec-index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

async function exists(file) {
  return fs.access(file).then(() => true, () => false);
}

async function memoryRoot() {
  const fromCwd = path.resolve(process.cwd(), '.dsh-mem');
  if (await exists(path.join(fromCwd, 'events.jsonl'))) return fromCwd;
  return path.resolve(HERE, '..', '..', '.dsh-mem');
}

function milliseconds(started) {
  return (performance.now() - started).toFixed(1);
}

async function main() {
  const query = process.argv.slice(2).join(' ').trim();
  if (!query) {
    console.log('vector_disabled: query is empty');
    return;
  }

  const root = await memoryRoot();
  const totalStarted = performance.now();
  const indexStarted = performance.now();
  let index = await loadVecIndex(root);
  const rebuilt = !index;
  if (!index) index = await buildVecIndex(root);
  const indexMs = milliseconds(indexStarted);
  if (!index) {
    console.log(`vector_disabled: ${vectorDisabledReason() ?? 'encoder unavailable'}`);
    return;
  }

  const queryStarted = performance.now();
  const encoded = await encodeVectors([query], { query: true });
  const queryMs = milliseconds(queryStarted);
  if (!encoded) {
    console.log(`vector_disabled: ${vectorDisabledReason() ?? 'encoder unavailable'}`);
    return;
  }

  const ranked = rankVecIndex(index, encoded[0], 5);
  ranked.forEach((item, indexPosition) => {
    console.log(`${indexPosition + 1}. ${item.id} ${item.cosine.toFixed(6)}`);
  });
  console.log(
    `timing_ms: index=${indexMs} query=${queryMs}`
      + ` total=${milliseconds(totalStarted)} rebuilt=${rebuilt}`,
  );
}

try {
  await main();
} catch (error) {
  console.log(`vector_disabled: ${error?.message ?? String(error)}`);
} finally {
  await vectorClient.dispose();
}
