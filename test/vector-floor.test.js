import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildVecIndex } from '../src/vector/vec-index.mjs';

function unitVector() {
  const vec = new Float32Array(512);
  vec[0] = 1;
  return { dim: 512, vec };
}

test('floor 用 46 条 query-doc 校准、夹边界，hash 变化时只重算 floor', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-memory-vector-floor-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'events.jsonl'), [
    JSON.stringify({ id: 'm_1', text: '正文一' }),
    JSON.stringify({ id: 'm_2', text: '正文二' }),
  ].join('\n').concat('\n'));

  const calls = [];
  const encode = async (texts, options) => {
    calls.push({ count: texts.length, query: options.query });
    return texts.map(unitVector);
  };
  const first = await buildVecIndex(root, { encode });

  assert.equal(first.metadata.cosineFloorP90, 0.75);
  assert.deepEqual(first.metadata.floorCalibration.queries, 46);
  assert.equal(first.metadata.floorCalibration.method, 'query-doc-p90');
  assert.equal(first.metadata.floorCalibration.version, 1);
  assert.equal(first.metadata.floor_clamped.raw, 1);
  assert.equal(calls.filter(({ query }) => query === false).length, 1);

  const metadataPath = path.join(root, 'vec.json');
  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  metadata.floorCalibration.sha256 = 'stale';
  fs.writeFileSync(metadataPath, JSON.stringify(metadata));
  calls.length = 0;
  const second = await buildVecIndex(root, { encode });

  assert.equal(calls.some(({ query }) => query === false), false);
  assert.equal(calls.reduce((sum, call) => sum + (call.query ? call.count : 0), 0), 46);
  assert.notEqual(second.metadata.floorCalibration.sha256, 'stale');
});
