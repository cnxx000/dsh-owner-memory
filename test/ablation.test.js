import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { apply } from '../src/index.js';

function fixture(t) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-memory-ablation-'));
  const localRoot = path.join(workspace, '.dsh-mem');
  fs.mkdirSync(localRoot, { recursive: true });
  const rule = {
    id: 'm_ablation_rule',
    ts: '2026-11-04T00:00:00.000Z',
    kind: 'rule',
    text: '保留这条红线',
    weight: 5,
  };
  const pit = {
    id: 'm_ablation_pit',
    ts: '2026-11-04T00:00:01.000Z',
    kind: 'note',
    text: '用于消融测试的坑',
    tags: ['坑'],
    weight: 3,
  };
  fs.writeFileSync(path.join(localRoot, 'state.json'), `${JSON.stringify({
    byId: { [rule.id]: rule, [pit.id]: pit },
    byKey: {},
    status: {
      [rule.id]: { status: 'active' },
      [pit.id]: { status: 'active' },
    },
    symptoms: { [pit.id]: ['消融测试报错'] },
  })}\n`);

  const variables = new Map();
  const host = {
    tools: { register() { return () => {}; } },
    systemPrompt: {
      variable(name, provider) {
        variables.set(name, provider);
        return () => {};
      },
    },
  };
  apply(host, { workspace });
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));

  return {
    localRoot,
    provider: variables.get('owner_memory'),
    health: () => JSON.parse(fs.readFileSync(path.join(localRoot, 'health.json'), 'utf8')),
    flag(value) {
      const file = path.join(localRoot, 'flags', 'ablation');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, value);
    },
  };
}

test('F1 无标志文件：正常注入且 health.ablation=none', (t) => {
  const current = fixture(t);
  const rendered = current.provider();

  assert.match(rendered, /## 长期记忆/u);
  assert.match(rendered, /> 踩过 1 类坑（/u);
  assert.equal(current.health().ablation, 'none');
});

test('F2 no-pit：只移除坑类索引行', (t) => {
  const current = fixture(t);
  const baseline = current.provider();
  current.flag('no-pit');
  const rendered = current.provider();
  const expected = baseline
    .split('\n')
    .filter((line) => !line.startsWith('> 踩过 '))
    .join('\n');

  assert.equal(rendered, expected);
  assert.doesNotMatch(rendered, /> 踩过 \d+ 类坑/u);
  assert.equal(current.health().ablation, 'no-pit');
});

test('F3 off：注入为空串且 health.ablation=off', (t) => {
  const current = fixture(t);
  current.flag('off');

  assert.equal(current.provider(), '');
  assert.equal(current.health().ablation, 'off');
});

test('F4 无法识别的标志：按 A 组处理', (t) => {
  const current = fixture(t);
  const baseline = current.provider();
  current.flag('这不是有效的消融标志');

  assert.equal(current.provider(), baseline);
  assert.equal(current.health().ablation, 'none');
});
