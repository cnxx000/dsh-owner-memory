#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from '../src/config.js';
import { buildIndex } from '../src/indexer.js';
import { pinnedIds } from '../src/l0.js';
import { loadAliasTable, recall } from '../src/recall.js';
import { rebuildState } from '../src/storage/event-log.js';
import { vectorClientFor } from '../src/vector/client.mjs';
import {
  buildVecIndex,
  cosineById,
  loadVecIndex,
} from '../src/vector/vec-index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(HERE, '..', '..');
const ROOT = path.join(WORKSPACE, '.dsh-mem');

const positives = [
  ['P01', '之前那个养鱼的插件，现在到底是关着、半开着还是彻底没了？', 'm_mw0sofv5_4f93'],
  ['P02', 'B站那份登录凭证放哪儿了？现在能用它发评论吗？', 'm_mig_644f99bff2'],
  ['P03', '把旧笔记导进新库的那个搬运工具，现在还能调用吗？', 'm_mw0cl4fk_4dbd'],
  ['P04', '以前那套萝莉预设包还装着吗？', 'm_mw0dms8c_989b'],
  ['P05', '做新插件之前，你该先提醒我干嘛？', 'm_mw0fycaa_ffe2'],
  ['P06', '让你去找别的模型讨论方案，聊到什么程度才算收工？', 'm_mw1iqtj4_9c94'],
  ['P07', '设计和写代码分别该找哪个模型？', 'm_mw1ixm3o_8d3d'],
  ['P08', '我改完文档准备收尾，有没有什么检查是必须跑的？', 'm_mw074084_2ebf'],
  ['P09', '从 B 站拉视频截图老报证书不对，咋整？', 'm_mw0sfw8c_ac05'],
  ['P10', '我把插件源码改了，为啥体检数字还是老样子？', 'm_mw1jgzmy_a5a0'],
  ['P11', '我一般几点睡、几点起？', null],
  ['P12', '我生日是哪天？', null],
  ['P13', '上次让你统计那个连接断掉的情况，结论是什么？', 'm_mw04dzia_7c97'],
  ['C1', '系统自带的那个蓝色终端，数文件有几行可信吗？', 'm_mw04e7s2_0593'],
  ['C2', '读那份宿主补丁配置时库报不认识的标记，咋绕过去？', 'm_mw0deiih_a440'],
  ['C3', '那个几十路同时落盘的测试偶尔红一次，算回归吗？', 'm_mw1n5p1m_dd5d'],
  ['C4', '按目录加载技能时，附带的参考文件是相对哪个根找的？', 'm_mw0fydwn_de28'],
].map(([id, query, expected]) => ({ id, query, expected, group: id.startsWith('C') ? 'C' : 'P' }));

const negativeQueries = [
  '主人平时几点睡觉、几点起床？',
  '主人早餐通常吃什么，有没有忌口？',
  '主人的身高是多少厘米？',
  '主人现在体重多少公斤？',
  '主人家里有哪些家庭成员？',
  '主人现实中养了什么宠物？',
  '主人的家庭住址在哪里？',
  '主人每天怎样通勤上班？',
  '主人喝咖啡喜欢什么豆和做法？',
  '主人平时喝酒吗，酒量怎么样？',
  '主人每周做什么运动？',
  '主人最喜欢哪一部电影？',
  '主人最近在玩什么电子游戏？',
  '主人最常听什么音乐或歌手？',
  '主人通常去哪里购物？',
  '主人正在使用的手机是什么型号？',
  '主人有没有汽车，车型是什么？',
  '主人下一次假期从哪天开始？',
  '主人最近一次旅行去了哪里？',
  '主人最近一次体检结果怎么样？',
  '主人的医保属于哪一种？',
  '主人每个月工资是多少？',
  '主人每月要交多少房租？',
  '主人最近一个快递的单号是什么？',
  '主人通常一周点几次外卖？',
  '主人点外卖偏爱什么口味？',
  '主人有没有养猫，猫叫什么？',
  '主人有没有养狗，狗叫什么？',
  '主人所在城市今天是什么天气？',
  '主人最喜欢怎样过节日？',
];
const negatives = negativeQueries.map((query, index) => ({
  id: `N${String(index + 1).padStart(2, '0')}`,
  query,
  expected: null,
  group: 'N',
}));
const cases = [...positives, ...negatives];

function percentile(values, fraction) {
  const ordered = [...values].sort((left, right) => left - right);
  if (ordered.length === 0) return 0;
  return ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)];
}

function chars(result) {
  return result.items.reduce((sum, item) => sum + item.text.length, 0);
}

function verdict(item, result, resident) {
  if (item.expected === null) return result.items.length === 0 ? 'empty' : `dirty:${result.items.length}`;
  if (resident.has(item.expected)) return 'L0';
  const rank = result.items.findIndex(({ id }) => id === item.expected) + 1;
  return rank ? `top${rank}` : 'miss';
}

function summarize(rows, mode) {
  const selected = rows.filter((row) => row.mode === mode);
  const p = selected.filter((row) => row.group === 'P' && row.expected !== null);
  const c = selected.filter((row) => row.group === 'C');
  const n = selected.filter((row) => row.group === 'N');
  const times = selected.map(({ ms }) => ms);
  const charValues = selected.map((row) => row.chars);
  return {
    evidenceP: p.filter((row) => row.hit).length,
    evidencePTotal: p.length,
    evidenceC: c.filter((row) => row.hit).length,
    evidenceCTotal: c.length,
    negativeEmpty: n.filter((row) => row.empty).length,
    negativeTotal: n.length,
    charsAverage: charValues.reduce((sum, value) => sum + value, 0) / charValues.length,
    charsMax: Math.max(...charValues),
    p50: percentile(times, 0.5),
    p95: percentile(times, 0.95),
  };
}

const config = resolveConfig({ workspace: WORKSPACE, root: ROOT });
const client = vectorClientFor({ modelDir: config.vector.modelDir });

try {
  const state = await rebuildState(ROOT, { ...config, recordRebuild: false });
  const index = buildIndex(state);
  const aliases = loadAliasTable(config.aliasesPath);
  const resident = pinnedIds(state);
  let vectorIndex = await loadVecIndex(ROOT);
  if (!vectorIndex) vectorIndex = await buildVecIndex(ROOT, {
    encode: (texts, options) => client.encode(texts, options),
  });
  if (!vectorIndex) throw new Error(`vector_disabled: ${client.disabledReason ?? 'index unavailable'}`);
  const floor = Number.isFinite(config.vector.floor)
    ? config.vector.floor
    : vectorIndex.metadata.cosineFloorP90;
  if (!Number.isFinite(floor)) throw new Error('vector index has no calibrated cosine floor');

  // 模型预热不计入热查询分位数。
  await client.encode(['向量评测预热'], { query: true });
  const rows = [];
  for (const item of cases) {
    let started = performance.now();
    const off = recall(state, index, item.query, {
      aliases,
      limit: config.recallLimit,
      maxChars: config.recallMaxChars,
    });
    let ms = performance.now() - started;
    let resultVerdict = verdict(item, off, resident);
    rows.push({
      ...item,
      mode: 'off',
      verdict: resultVerdict,
      hit: item.expected !== null && resultVerdict !== 'miss',
      empty: off.items.length === 0,
      chars: chars(off),
      ms,
    });

    started = performance.now();
    const encoded = await client.encode([item.query], { query: true });
    if (!encoded) throw new Error(`vector_disabled: ${client.disabledReason ?? 'encoder unavailable'}`);
    const cosines = cosineById(vectorIndex, encoded[0]);
    const cosineRanking = Object.entries(cosines)
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
    const on = recall(state, index, item.query, {
      aliases,
      limit: config.recallLimit,
      maxChars: config.recallMaxChars,
      vec: {
        cosById: cosines,
        floor,
        beta: config.vector.beta,
      },
    });
    ms = performance.now() - started;
    resultVerdict = verdict(item, on, resident);
    rows.push({
      ...item,
      mode: 'on',
      verdict: resultVerdict,
      hit: item.expected !== null && resultVerdict !== 'miss',
      empty: on.items.length === 0,
      chars: chars(on),
      ms,
      cosineTop4: cosineRanking.slice(0, 4),
      expectedCosine: item.expected ? cosines[item.expected] : null,
      expectedCosineRank: item.expected
        ? cosineRanking.findIndex(([id]) => id === item.expected) + 1
        : null,
    });
  }

  console.log(`floor=${floor.toFixed(6)} beta=${config.vector.beta}`);
  console.log('| case | vector off | vector on | chars off/on | ms off/on |');
  console.log('| --- | --- | --- | ---: | ---: |');
  for (const item of cases) {
    const off = rows.find((row) => row.id === item.id && row.mode === 'off');
    const on = rows.find((row) => row.id === item.id && row.mode === 'on');
    console.log(
      `| ${item.id} | ${off.verdict} | ${on.verdict}`
      + ` | ${off.chars}/${on.chars} | ${off.ms.toFixed(1)}/${on.ms.toFixed(1)} |`,
    );
  }

  const off = summarize(rows, 'off');
  const on = summarize(rows, 'on');
  console.log('\n| mode | P evidence | C evidence | negatives empty | chars avg/max | latency p50/p95 ms |');
  console.log('| --- | ---: | ---: | ---: | ---: | ---: |');
  for (const [mode, summary] of [['off', off], ['on', on]]) {
    console.log(
      `| vector ${mode} | ${summary.evidenceP}/${summary.evidencePTotal}`
      + ` | ${summary.evidenceC}/${summary.evidenceCTotal}`
      + ` | ${summary.negativeEmpty}/${summary.negativeTotal}`
      + ` | ${summary.charsAverage.toFixed(1)}/${summary.charsMax}`
      + ` | ${summary.p50.toFixed(1)}/${summary.p95.toFixed(1)} |`,
    );
  }

  console.log('\nC cosine diagnostics:');
  for (const item of positives.filter(({ group }) => group === 'C')) {
    const onRow = rows.find((row) => row.id === item.id && row.mode === 'on');
    const top4 = onRow.cosineTop4
      .map(([id, cosine]) => `${id}:${cosine.toFixed(6)}`)
      .join(', ');
    console.log(
      `${item.id} top4=[${top4}] expected=${item.expected}`
      + ` cosine=${onRow.expectedCosine.toFixed(6)} rank=${onRow.expectedCosineRank}`,
    );
  }
} catch (error) {
  console.error(error?.message ?? String(error));
  process.exitCode = 1;
} finally {
  await client.dispose();
}

// Guard against accidentally evaluating a different workspace snapshot.
if (!fs.existsSync(path.join(ROOT, 'events.jsonl'))) process.exitCode = 1;
