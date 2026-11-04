import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mineAliasProposals } from '../src/alias-mining.js';

export async function main(argv = process.argv.slice(2)) {
  const root = path.resolve(argv[0] ?? '.dsh-mem');
  const result = await mineAliasProposals(root);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  await main();
}
