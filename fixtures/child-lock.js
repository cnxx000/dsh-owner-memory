import fs from 'node:fs';
import { withLock } from '../src/storage/lock.js';

const [root, trace, label] = process.argv.slice(2);

await withLock(root, `contender-${label}`, async () => {
  fs.appendFileSync(trace, `start:${label}\n`);
  await new Promise((resolve) => setTimeout(resolve, 100));
  fs.appendFileSync(trace, `end:${label}\n`);
});
