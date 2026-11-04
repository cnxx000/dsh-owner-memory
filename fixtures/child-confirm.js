import { recordDuplicate } from '../src/write/dedup.js';

const [root, id, session] = process.argv.slice(2);
await recordDuplicate(root, id, new Date(), { confirmSess: session });
