import fs from 'node:fs';
import path from 'node:path';

const MODES = new Set(['none', 'no-pit', 'off']);

export function readAblation(root) {
  try {
    const value = fs.readFileSync(path.join(root, 'flags', 'ablation'), 'utf8').trim().toLowerCase();
    if (value === '') return 'none';
    const flags = value.split(/[\s,]+/u);
    if (flags.includes('off')) return 'off';
    if (flags.includes('no-pit')) return 'no-pit';
    return 'none';
  } catch {
    return 'none';
  }
}

export function normalizeAblation(value) {
  return MODES.has(value) ? value : 'none';
}
