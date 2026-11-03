import { resolveConfig } from '../src/config.js';
import { memNote } from '../src/tools/mem_note.js';

const [workspace, label, countText] = process.argv.slice(2);
const config = resolveConfig({ workspace });
const count = Number(countText);

for (let index = 0; index < count; index += 1) {
  await memNote(config, {
    kind: 'note',
    text: `2026-11-02 子进程 ${label} 写入序号 ${index}。`,
  }, { sessionId: `child-${label}` });
}
