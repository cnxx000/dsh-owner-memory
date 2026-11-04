#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from '../src/config.js';
import { buildIndex } from '../src/indexer.js';
import { loadAliasTable, recall } from '../src/recall.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(HERE, '..', '..');
const QUERIES_FILE = path.join(WORKSPACE, 'pit-recall-queries.json');
const ROOT = path.join(WORKSPACE, '.dsh-mem');

const queries = JSON.parse(fs.readFileSync(QUERIES_FILE, 'utf8'));
const state = JSON.parse(fs.readFileSync(path.join(ROOT, 'state.json'), 'utf8'));
const baseConfig = resolveConfig({ workspace: WORKSPACE, root: ROOT });
const aliases = loadAliasTable(baseConfig.aliasesPath);

function evaluate(symptomsInRecall) {
  const config = resolveConfig({
    workspace: WORKSPACE,
    root: ROOT,
    symptomsInRecall,
  });
  const index = buildIndex(state, config);
  return queries.map(({ id, q }) => {
    const result = recall(state, index, q, {
      aliases,
      limit: 5,
      maxChars: config.recallMaxChars,
      symptomsInRecall: config.symptomsInRecall,
    });
    const rank = result.items.findIndex((item) => item.id === id) + 1;
    return { id, q, rank: rank || null };
  });
}

const baseline = evaluate(false);
const experiment = evaluate(true);
const baselineHits = baseline.filter(({ rank }) => rank !== null).length;
const experimentHits = experiment.filter(({ rank }) => rank !== null).length;

console.log('| id | 基线 | 实验组 | 查询 |');
console.log('| --- | ---: | ---: | --- |');
for (let index = 0; index < queries.length; index += 1) {
  const off = baseline[index];
  const on = experiment[index];
  const verdict = ({ rank }) => (rank === null ? '未命中' : `命中 #${rank}`);
  console.log(`| ${off.id} | ${verdict(off)} | ${verdict(on)} | ${off.q} |`);
}
console.log(`\n基线命中：${baselineHits}/${queries.length}`);
console.log(`实验组命中：${experimentHits}/${queries.length}`);
console.log(`差值：${experimentHits - baselineHits >= 0 ? '+' : ''}${experimentHits - baselineHits}`);
