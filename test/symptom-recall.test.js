import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveState } from '../src/derive.js';
import { buildIndex, eventSearchText } from '../src/indexer.js';
import { recall } from '../src/recall.js';
import { validateEvent } from '../src/schema.js';

const NOW = Date.parse('2026-11-04T12:00:00+08:00');

function event(id, kind, text, extra = {}) {
  return {
    id,
    ts: new Date(NOW + (extra.offset ?? 0)).toISOString(),
    kind,
    text,
    weight: 4,
    sess: 'symptom-recall-test',
    ...extra,
    offset: undefined,
  };
}

function run(state, query, symptomsInRecall) {
  const options = { now: NOW, limit: 5, symptomsInRecall };
  return recall(state, buildIndex(state, options), query, options);
}

test('S1：关闭时固定查询的 picked 列表保持原有结果', () => {
  const state = deriveState([
    event('m_s1_old', 'note', '部署失败后先检查证书。', { offset: -1000 }),
    event('m_s1_new', 'note', '部署失败后清理构建缓存。'),
    event('m_s1_other', 'note', '完全无关的记录。', { tags: ['坑'] }),
    event('m_s1_symptom', 'symptom', '症状词：部署失败', {
      refs: ['m_s1_other'],
      symptoms: ['部署失败'],
      src: 'review',
    }),
  ]);

  assert.deepEqual(
    run(state, '部署失败', false).items.map(({ id }) => id),
    ['m_s1_new', 'm_s1_old'],
  );
});

test('S2：开启后仅靠症状词可让被引用条目进入前 5', () => {
  const target = event('m_s2_target', 'note', '排查宿主加载路径。', { tags: ['坑'] });
  const symptom = event('m_s2_symptom', 'symptom', '症状词：插件完全静默', {
    refs: [target.id],
    symptoms: ['插件完全静默'],
    src: 'review',
  });
  const state = deriveState([target, symptom]);

  assert.deepEqual(run(state, '插件完全静默', false).items, []);
  assert.equal(run(state, '插件完全静默', true).items[0].id, target.id);
});

test('S3：症状词不改变 eventSearchText，也不产生独立候选条目', () => {
  const target = event('m_s3_target', 'note', '检查配置加载阶段。', { tags: ['坑'] });
  const symptom = event('m_s3_symptom', 'symptom', '症状词：幽灵报错', {
    refs: [target.id],
    symptoms: ['幽灵报错'],
    src: 'review',
  });
  const state = deriveState([target, symptom]);
  const index = buildIndex(state, { symptomsInRecall: true });
  const result = recall(state, index, '幽灵报错', {
    now: NOW,
    limit: 5,
    symptomsInRecall: true,
  });

  assert.equal(eventSearchText(symptom), '');
  assert.equal(eventSearchText(target), '检查配置加载阶段。  坑');
  assert.deepEqual(result.items.map(({ id }) => id), [target.id]);
  assert.ok(Object.values(index.postings).every((ids) => !ids.includes(symptom.id)));
});

test('S4：目标条目 retract 后，其症状词不再参与召回', () => {
  const target = event('m_s4_target', 'note', '检查运行时状态。', { tags: ['坑'] });
  const symptom = event('m_s4_symptom', 'symptom', '症状词：窗口状态打架', {
    refs: [target.id],
    symptoms: ['窗口状态打架'],
    src: 'review',
  });
  const retract = event('m_s4_retract', 'retract', '撤销错误记录。', {
    refs: [target.id],
    offset: 1000,
  });
  const state = deriveState([target, symptom, retract]);

  assert.equal(state.symptoms[target.id], undefined);
  assert.deepEqual(run(state, '窗口状态打架', true).items, []);
});

test('A1：symptom 事件可只有 asks；两者都没有时报 E_SYMPTOM_EMPTY', () => {
  const asksOnly = event('m_a1_0001', 'symptom', '问法：插件为什么一直没有反应', {
    refs: ['m_a1_0000'],
    asks: ['插件为什么一直没有反应'],
    src: 'review',
  });

  assert.doesNotThrow(() => validateEvent(asksOnly));
  assert.throws(
    () => validateEvent({
      ...asksOnly,
      id: 'm_a1_0002',
      asks: undefined,
    }),
    (error) => error.code === 'E_SYMPTOM_EMPTY',
  );
});

test('A2：asks 每条必须为 6–40 字且不含换行', () => {
  const base = event('m_a2_0001', 'symptom', '问法边界测试。', {
    refs: ['m_a2_0000'],
    src: 'review',
  });

  for (const asks of [
    ['五个字问法'],
    ['超'.repeat(41)],
    ['这个问法中\n带换行'],
  ]) {
    assert.throws(
      () => validateEvent({ ...base, asks }),
      (error) => error.code === 'E_SCHEMA',
    );
  }
  assert.doesNotThrow(() => validateEvent({ ...base, asks: ['六个字的问法'] }));
});

test('A3：开启后仅靠 asks 可让目标进入前 5', () => {
  const target = event('m_a3_target', 'note', '检查宿主初始化流程。', { tags: ['坑'] });
  const asks = event('m_a3_asks', 'symptom', '问法：为什么插件启动后完全没动静', {
    refs: [target.id],
    asks: ['为什么插件启动后完全没动静'],
    src: 'review',
  });
  const state = deriveState([target, asks]);

  assert.deepEqual(run(state, '为什么插件启动后完全没动静', false).items, []);
  assert.ok(
    run(state, '为什么插件启动后完全没动静', true).items
      .slice(0, 5)
      .some(({ id }) => id === target.id),
  );
});

test('A4：关闭时 asks 不改变固定查询的逐条结果', () => {
  const state = deriveState([
    event('m_a4_old', 'note', '配置加载失败后检查路径。', { offset: -1000 }),
    event('m_a4_new', 'note', '配置加载失败后检查缓存。'),
    event('m_a4_other', 'note', '无关的坑记录。', { tags: ['坑'] }),
    event('m_a4_asks', 'symptom', '问法：配置加载失败怎么办', {
      refs: ['m_a4_other'],
      asks: ['配置加载失败应该怎么办'],
      src: 'review',
    }),
  ]);

  assert.deepEqual(
    run(state, '配置加载失败', false).items.map(({ id }) => id),
    ['m_a4_new', 'm_a4_old'],
  );
});

test('A5：目标 retract 后 asks 失效', () => {
  const target = event('m_a5_target', 'note', '检查窗口共享状态。', { tags: ['坑'] });
  const asks = event('m_a5_asks', 'symptom', '问法：为什么两个窗口显示不一样', {
    refs: [target.id],
    asks: ['为什么两个窗口显示不一样'],
    src: 'review',
  });
  const retract = event('m_a5_retract', 'retract', '撤销错误记录。', {
    refs: [target.id],
    offset: 1000,
  });
  const state = deriveState([target, asks, retract]);

  assert.equal(state.asks[target.id], undefined);
  assert.deepEqual(run(state, '为什么两个窗口显示不一样', true).items, []);
});
