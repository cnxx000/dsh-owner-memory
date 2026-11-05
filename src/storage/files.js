import fs from 'node:fs';
import path from 'node:path';
import { DEFAULTS } from '../config.js';

const WINDOWS_TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY']);

export function sleepSync(ms) {
  if (ms <= 0) return;
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, ms);
}

export function retryWindows(operation, delays = DEFAULTS.retryDelaysMs) {
  let lastError;
  for (const delay of delays) {
    sleepSync(delay);
    try {
      return operation();
    } catch (error) {
      lastError = error;
      if (process.platform !== 'win32' || !WINDOWS_TRANSIENT.has(error.code)) throw error;
    }
  }
  throw lastError;
}

export function fsyncDirectory(directory) {
  let fd;
  try {
    fd = fs.openSync(directory, 'r');
    fs.fsyncSync(fd);
  } catch (error) {
    // Windows 不保证目录句柄可 fsync；文件本身已经落盘，目录同步是额外耐久性。
    if (process.platform !== 'win32') throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function atomicWrite(file, content, options = {}) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = `${file}.tmp.${process.pid}.${Math.random().toString(16).slice(2)}`;
  const fd = fs.openSync(temporary, 'w');
  try {
    fs.writeFileSync(fd, content, options);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    retryWindows(() => fs.renameSync(temporary, file));
    fsyncDirectory(directory);
  } catch (error) {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // 保留原始异常；临时文件清理失败不应掩盖写入失败。
    }
    throw error;
  }
}

export function initRoot(root) {
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(path.join(root, 'corrupt'), { recursive: true });
  fs.mkdirSync(path.join(root, 'archive'), { recursive: true });

  const events = path.join(root, 'events.jsonl');
  let createdEvents = false;
  if (!fs.existsSync(events)) {
    try {
      const fd = fs.openSync(events, 'wx');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      createdEvents = true;
    } catch (error) {
      // 两个进程首次启动时，另一个进程可能刚完成同一个 wx 创建。
      if (error.code !== 'EEXIST') throw error;
    }
  }
  // 空锁目录只用于满足首次初始化布局；正常释放后不重建，否则会与抢占 rename 竞态。
  if (createdEvents) fs.mkdirSync(path.join(root, '.lock'));
  const ignore = path.join(root, '.gitignore');
  if (!fs.existsSync(ignore) || fs.readFileSync(ignore, 'utf8') !== '*') atomicWrite(ignore, '*');
  return root;
}

export function timestampForFile(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

export function preserveCorruptLine(root, lineNumber, rawLine, now = new Date()) {
  const file = path.join(root, 'corrupt', `events-${timestampForFile(now)}-${process.pid}.jsonl`);
  const evidence = JSON.stringify({ line: lineNumber, raw: rawLine });
  fs.appendFileSync(file, `${evidence}\n`, 'utf8');
  return file;
}

export function readJson(file, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return structuredClone(fallback);
    throw error;
  }
}

/**
 * 把一次 L0 渲染算出的配额指标落进 health.json。
 *
 * 2026-11-03 修：`renderPinned(state, { health })` 的 health 一直传的是临时对象
 * （index.js 的 makeProvider），算完就丢，于是 audit 读到的 `rules_overflow`
 * 永远是 health.json 里的默认值 —— 指标是死的，实际截断了也报 false。
 */
export function persistPinnedHealth(root, health = {}) {
  return updateHealth(root, (current) => ({
    ...current,
    ablation: ['none', 'no-pit', 'off'].includes(health.ablation)
      ? health.ablation
      : 'none',
    rules_overflow: health.rules_overflow === true,
    rules_truncated_hard: health.rules_truncated_hard === true,
    rules_near_limit: health.rules_near_limit === true,
    fact_overflow: Array.isArray(health.fact_overflow) ? [...health.fact_overflow] : [],
    fact_headline_missing: Array.isArray(health.fact_headline_missing)
      ? [...health.fact_headline_missing]
      : [],
    pit_overflow: Array.isArray(health.pit_overflow) ? [...health.pit_overflow] : [],
    pit_symptom_missing: Array.isArray(health.pit_symptom_missing)
      ? [...health.pit_symptom_missing]
      : [],
  }));
}

export function updateHealth(root, patch) {
  const file = path.join(root, 'health.json');
  const current = readJson(file, {
    corruptLines: 0,
    corruptLinesEver: 0,
    lock_stolen: 0,
    rebuilt: 0,
    rules_overflow: 0,
    fact_overflow: [],
    fact_headline_missing: [],
    pit_overflow: [],
    pit_symptom_missing: [],
    injection_missing: false,
    ablation: 'none',
  });
  const next = typeof patch === 'function' ? patch(current) : { ...current, ...patch };
  atomicWrite(file, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}
