import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveConfig } from '../src/config.js';
import { deriveState } from '../src/derive.js';
import { buildIndex, eventSearchText } from '../src/indexer.js';
import { renderPinned } from '../src/l0.js';
import { recall } from '../src/recall.js';
import { scoreEvent } from '../src/score.js';
import { readJson } from '../src/storage/files.js';
import { readEvents } from '../src/storage/event-log.js';
import { memFix } from '../src/tools/mem_fix.js';
import { memNote } from '../src/tools/mem_note.js';

const NOW = Date.parse('2026-11-04T12:00:00+08:00');

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-memory-pit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return resolveConfig({ workspace: root });
}

function event(id, kind, extra = {}) {
  const finalDigit = Number(id.slice(-1));
  return {
    id,
    ts: new Date(NOW + (Number.isFinite(finalDigit) ? finalDigit : 0) * 1000).toISOString(),
    kind,
    text: `测试事件 ${id}`,
    weight: 2,
    sess: 'pit-test',
    ...extra,
  };
}

function pitLine(pinned) {
  return pinned.split('\n').find((line) => line.startsWith('> 踩过 '));
}

function pitWithSymptoms(id, ts, symptoms, weight = 2) {
  const note = event(id, 'note', { ts, tags: ['坑'], weight });
  return [
    note,
    event(`s_${id}`, 'symptom', {
      ts,
      refs: [id],
      symptoms,
      src: 'review',
    }),
  ];
}

test('G1：默认类别词渲染在 50 字内', (t) => {
  const config = workspace(t);
  const health = {};
  const state = deriveState(pitWithSymptoms(
    'm_g1',
    '2026-11-04T00:00:00.000Z',
    ['具体症状不应渲染'],
  ));
  const line = pitLine(renderPinned(state, {
    health,
    localRoot: config.localRoot,
    now: new Date(NOW),
  }));

  assert.equal(line, '> 踩过 1 类坑（解析、注入、工具注册、凭据、证书）→ 报错/没反应/不出现先 mem_recall');
  assert.ok([...line.slice(2)].length <= 50);
  assert.deepEqual(health.pit_overflow, []);
});

test('G2：pit-categories.txt 取前 5 个类别词', (t) => {
  const config = workspace(t);
  fs.mkdirSync(config.localRoot, { recursive: true });
  fs.writeFileSync(
    path.join(config.localRoot, 'pit-categories.txt'),
    '配置\n宿主\n工具\n权限\n缓存\n未采用\n',
  );
  const health = {};
  const state = deriveState(pitWithSymptoms(
    'm_g2',
    '2026-11-04T00:00:00.000Z',
    ['不会展示的症状'],
  ));
  const line = pitLine(renderPinned(state, {
    health,
    localRoot: config.localRoot,
    now: new Date(NOW),
  }));

  assert.match(line, /（配置、宿主、工具、权限、缓存）/u);
  assert.doesNotMatch(line, /解析|未采用/u);
  assert.deepEqual(health.pit_overflow, ['未采用']);
});

test('G3：N 等于 active 且有症状词的坑数', () => {
  const state = deriveState([
    ...pitWithSymptoms('m_g3_active_a', '2026-11-04T00:00:00.000Z', ['症状甲']),
    ...pitWithSymptoms('m_g3_active_b', '2026-11-03T00:00:00.000Z', ['症状乙']),
    ...pitWithSymptoms('m_g3_inactive', '2026-11-02T00:00:00.000Z', ['症状丙']),
    event('m_g3_missing', 'note', { tags: ['坑'] }),
  ]);
  state.status.m_g3_inactive = { status: 'retracted' };
  const health = {};
  const line = pitLine(renderPinned(state, { health, now: new Date(NOW) }));

  assert.match(line, /^> 踩过 2 类坑/u);
  assert.deepEqual(health.pit_symptom_missing, ['m_g3_missing']);
});

test('G4：无坑时不渲染索引行', () => {
  const health = {};
  const line = pitLine(renderPinned(deriveState([]), { health, now: new Date(NOW) }));

  assert.equal(line, undefined);
  assert.deepEqual(health.pit_overflow, []);
});

test('G5：状态不变时连续两次 renderPinned 逐字节一致', () => {
  const state = deriveState(pitWithSymptoms(
    'm_g5',
    '2026-11-04T00:00:00.000Z',
    ['症状甲', '症状乙'],
  ));
  const options = { now: new Date(NOW) };

  assert.equal(renderPinned(state, options), renderPinned(state, options));
});

const PRODUCTION_PIT_SYMPTOMS = [
  '标签解析错',
  '工具一个不出现',
  '向量没效果',
  '组装期误判缺失',
  '键被删空',
  '取代写成撤销',
  '插件静默不启动',
  '服务名写错',
  '假测试全绿',
  '指纹误判改动',
  '测登录误报',
  '凭据误报',
  '评测被污染',
  '并发测试偶红',
  '自检误判引用',
  '改源码不生效',
  '确认次数不涨',
  '证书报错',
  'skill 缺失',
  '红线溢出误报',
  '提示词塞错',
  '档位不生效',
  '附件路径错',
  '多窗口共享指标',
  '注入误报',
  '数行数少算',
  '依赖解析失败',
  '工具定义模板',
  '记忆落错位置',
  '登录状态读错',
  '测试夹具串线',
  '输出结构缺字段',
  '旧构建未清理',
];

test('G6：33 条症状词的现网副本渲染为 50 字门铃', () => {
  const events = PRODUCTION_PIT_SYMPTOMS.flatMap((symptom, index) => pitWithSymptoms(
    `m_g6_${String(index).padStart(2, '0')}`,
    new Date(Date.parse('2026-11-04T12:00:00.000Z') - index * 1000).toISOString(),
    [symptom],
    4,
  ));
  const line = pitLine(renderPinned(deriveState(events), { health: {}, now: new Date(NOW) }));

  assert.equal(
    line,
    '> 踩过 33 类坑（解析、注入、工具注册、凭据、证书）→ 报错/没反应/不出现先 mem_recall',
  );
  console.info(`G6 现网副本索引行=${line}`);
});

test('有 symptom 的坑 note 渲染索引，无 symptom 时不渲染', async (t) => {
  const config = workspace(t);
  await memNote(config, {
    kind: 'note',
    text: '证书失败时需要刷新本地信任链。',
    tags: ['坑'],
  }, { sessionId: 'missing' });
  let state = readJson(path.join(config.localRoot, 'state.json'));
  const missingHealth = {};
  assert.equal(pitLine(renderPinned(state, { health: missingHealth })), undefined);
  assert.equal(missingHealth.pit_symptom_missing.length, 1);

  await memNote(config, {
    kind: 'note',
    text: '改完源码后仍可能加载旧构建产物。',
    tags: ['坑'],
    symptom: ['改源码不生效'],
  }, { sessionId: 'present' });
  state = readJson(path.join(config.localRoot, 'state.json'));
  assert.match(pitLine(renderPinned(state, { health: {} })), /^> 踩过 1 类坑/u);
});

test('T3：retract 使症状失效，replaces 让症状跟到新条目并可复活旧条目', async (t) => {
  const revisedOriginal = event('m_t3note1', 'note', {
    text: '旧的坑记录。',
    tags: ['坑'],
  });
  const reviewedSymptom = event('m_t3sym2', 'symptom', {
    text: '症状词：旧症状',
    refs: [revisedOriginal.id],
    symptoms: ['旧症状'],
    src: 'review',
  });
  const revision = event('m_t3rev3', 'revise', {
    text: '修订后的坑记录。',
    refs: [revisedOriginal.id],
  });
  const revisedState = deriveState([revisedOriginal, reviewedSymptom, revision]);
  assert.deepEqual(revisedState.symptoms[revision.id], ['旧症状']);
  assert.match(pitLine(renderPinned(revisedState, { health: {} })), /^> 踩过 1 类坑/u);

  const config = workspace(t);
  const original = await memNote(config, {
    kind: 'note',
    text: 'PowerShell 输出行数有时不能直接相信。',
    tags: ['坑'],
    symptom: ['数行不准'],
  }, { sessionId: 't3-original' });
  const replacement = await memNote(config, {
    kind: 'note',
    text: 'PowerShell 输出应先转数组再统计行数。',
    tags: ['坑'],
    replaces: [original.id],
  }, { sessionId: 't3-replacement' });

  let state = readJson(path.join(config.localRoot, 'state.json'));
  assert.deepEqual(state.symptoms[replacement.id], ['数行不准']);
  assert.match(pitLine(renderPinned(state, { health: {} })), /^> 踩过 1 类坑/u);

  await memFix(config, {
    op: 'retract',
    refs: [replacement.id],
    text: '撤销替代条目。',
  }, { sessionId: 't3-retract-replacement' });
  state = readJson(path.join(config.localRoot, 'state.json'));
  assert.equal(state.status[original.id].status, 'active');
  assert.equal(state.symptoms[replacement.id], undefined);
  assert.match(pitLine(renderPinned(state, { health: {} })), /^> 踩过 1 类坑/u);

  await memFix(config, {
    op: 'retract',
    refs: [original.id],
    text: '撤销原坑记录。',
  }, { sessionId: 't3-retract-original' });
  state = readJson(path.join(config.localRoot, 'state.json'));
  assert.equal(pitLine(renderPinned(state, { health: {} })), undefined);
});

test('T4：症状词不进 eventSearchText，不改变原条评分和召回结果', () => {
  const note = event('m_note4', 'note', {
    text: '部署失败时按既定步骤处理。',
    tags: ['坑'],
    weight: 4,
  });
  const symptom = event('m_sym4', 'symptom', {
    text: '症状词：证书报错',
    refs: [note.id],
    symptoms: ['证书报错'],
    src: 'agent',
  });
  const plain = deriveState([note]);
  const enriched = deriveState([note, symptom]);
  const plainIndex = buildIndex(plain);
  const enrichedIndex = buildIndex(enriched);

  assert.equal(eventSearchText(symptom), '');
  assert.deepEqual(enrichedIndex, plainIndex);
  assert.equal(
    scoreEvent(enriched, enrichedIndex, enriched.byId[note.id], '部署失败', { now: NOW }).score,
    scoreEvent(plain, plainIndex, plain.byId[note.id], '部署失败', { now: NOW }).score,
  );
  assert.deepEqual(
    recall(enriched, enrichedIndex, '部署失败', { now: NOW }),
    recall(plain, plainIndex, '部署失败', { now: NOW }),
  );
  assert.deepEqual(recall(enriched, enrichedIndex, '证书报错', { now: NOW }).items, []);
});

test('T5：非坑 note 带 symptom 被拒；同会话超过 3 个时丢弃并保留 note', async (t) => {
  const config = workspace(t);
  await assert.rejects(
    memNote(config, {
      kind: 'note',
      text: '普通记录不能挂症状词。',
      symptom: ['普通报错'],
    }, { sessionId: 't5-invalid' }),
    (error) => error.code === 'E_SYMPTOM_KIND',
  );

  const first = await memNote(config, {
    kind: 'note',
    text: '第一条坑记录。',
    tags: ['坑'],
    symptom: ['证书报错', '握手失败'],
  }, { sessionId: 't5-cap' });
  const second = await memNote(config, {
    kind: 'note',
    text: '第二条完全不同的坑记录。',
    tags: ['坑'],
    symptom: ['源码没变', '缓存未清'],
  }, { sessionId: 't5-cap' });

  assert.equal(first.status, 'written');
  assert.equal(second.status, 'written');
  assert.ok(second.warnings?.some((warning) => warning.includes('缓存未清')));
  const events = readEvents(config.localRoot).events;
  assert.equal(events.filter((item) => item.kind === 'note').length, 2);
  assert.equal(
    events.filter((item) => item.kind === 'symptom')
      .flatMap((item) => item.symptoms).length,
    3,
  );
});
