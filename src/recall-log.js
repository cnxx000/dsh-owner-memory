import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULTS } from './config.js';
import { atomicWrite, initRoot, readJson, sleepSync } from './storage/files.js';

const MAX_RECEIPTS = 200;

function recentLines(file, limit) {
  if (!fs.existsSync(file) || limit <= 0) return [];
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    let position = size;
    let buffer = Buffer.alloc(0);
    let lineCount = 0;
    const chunkSize = 64 * 1024;
    while (position > 0 && lineCount <= limit) {
      const length = Math.min(chunkSize, position);
      position -= length;
      const chunk = Buffer.allocUnsafe(length);
      fs.readSync(fd, chunk, 0, length, position);
      buffer = Buffer.concat([chunk, buffer]);
      lineCount = buffer.reduce((count, byte) => count + (byte === 10 ? 1 : 0), 0);
    }
    const text = buffer.toString('utf8');
    return text.split(/\r?\n/u).filter(Boolean).slice(-limit);
  } finally {
    fs.closeSync(fd);
  }
}

function acquireLogLock(root) {
  const lock = path.join(root, '.recall-log.lock');
  const deadline = Date.now() + DEFAULTS.lockMaxWaitMs;
  const token = crypto.randomBytes(12).toString('hex');
  let attempt = 0;
  while (Date.now() <= deadline) {
    sleepSync(DEFAULTS.retryDelaysMs[attempt % DEFAULTS.retryDelaysMs.length]);
    attempt += 1;
    try {
      fs.mkdirSync(lock);
      atomicWrite(path.join(lock, 'owner.json'), `${JSON.stringify({
        pid: process.pid,
        ts: new Date().toISOString(),
        token,
      })}\n`);
      return { lock, token };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = readJson(path.join(lock, 'owner.json'), null);
      if (owner && Date.now() - Date.parse(owner.ts) > DEFAULTS.staleLockMs) {
        const garbage = `${lock}.stale.${process.pid}.${token}`;
        try {
          fs.renameSync(lock, garbage);
          fs.rmSync(garbage, { recursive: true, force: true });
        } catch (staleError) {
          if (!['ENOENT', 'EEXIST', 'EPERM', 'EACCES', 'EBUSY'].includes(staleError.code)) {
            throw staleError;
          }
        }
      }
    }
  }
  const error = new Error('recall-log 写锁超时');
  error.code = 'E_LOCK_TIMEOUT';
  throw error;
}

function releaseLogLock(lease) {
  const owner = readJson(path.join(lease.lock, 'owner.json'), null);
  if (owner?.token === lease.token) fs.rmSync(lease.lock, { recursive: true, force: true });
}

export function appendReceipt(root, receipt) {
  initRoot(root);
  const lease = acquireLogLock(root);
  try {
    const file = path.join(root, 'recall-log.jsonl');
    fs.appendFileSync(file, `${JSON.stringify(receipt)}\n`, 'utf8');
    const lines = recentLines(file, MAX_RECEIPTS + 1);
    if (lines.length > MAX_RECEIPTS) {
      // 只从文件尾回读最多 201 条；即使旧文件异常膨胀，也不会整文件载入内存。
      atomicWrite(file, `${lines.slice(-MAX_RECEIPTS).join('\n')}\n`);
    }
  } finally {
    releaseLogLock(lease);
  }
  return receipt;
}

export function readReceipts(root, { limit = MAX_RECEIPTS } = {}) {
  const bounded = Math.min(MAX_RECEIPTS, Math.max(0, limit));
  const file = path.join(root, 'recall-log.jsonl');
  return recentLines(file, bounded)
    .reverse()
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

export { MAX_RECEIPTS };
