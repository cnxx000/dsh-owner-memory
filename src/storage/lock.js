import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULTS } from '../config.js';
import { MemoryError } from '../schema.js';
import { readJson, retryWindows, sleepSync, updateHealth } from './files.js';

const mutexes = new Map();
const LOCK_CONTENTION_CODES = new Set(['EEXIST', 'ENOENT', 'EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY']);

class AsyncMutex {
  #tail = Promise.resolve();

  async run(task) {
    const previous = this.#tail;
    let release;
    this.#tail = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await task();
    } finally {
      release();
    }
  }
}

function mutexFor(root) {
  const key = path.resolve(root);
  if (!mutexes.has(key)) mutexes.set(key, new AsyncMutex());
  return mutexes.get(key);
}

function ownerFile(root) {
  return path.join(root, '.lock', 'owner.json');
}

function readOwner(root) {
  return readJson(ownerFile(root), null);
}

function isStale(owner, staleLockMs, now = Date.now()) {
  if (!owner?.ts) return true;
  const timestamp = Date.parse(owner.ts);
  return !Number.isFinite(timestamp) || now - timestamp > staleLockMs;
}

function leaseDirectoryIsStale(directory, owner, staleLockMs) {
  if (owner) return isStale(owner, staleLockMs);
  try {
    // mkdir 与 owner.json 写入之间有极短窗口；无 owner 时先看目录年龄，不能当场抢走。
    return Date.now() - fs.statSync(directory).mtimeMs > staleLockMs;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function readLeaseOwner(directory) {
  return readJson(path.join(directory, 'owner.json'), null);
}

function ownsLease(directory, token) {
  return readLeaseOwner(directory)?.token === token;
}

function writeOwner(file, owner) {
  // 锁元数据只服务当前运行期；崩溃后靠目录 mtime/陈旧抢占恢复，不需要派生文件级 fsync。
  fs.writeFileSync(file, `${JSON.stringify(owner)}\n`, 'utf8');
}

function tryAcquireClaim(root, op, staleLockMs) {
  const claim = path.join(root, '.lock-claim');
  const token = crypto.randomBytes(16).toString('hex');
  try {
    fs.mkdirSync(claim);
    writeOwner(path.join(claim, 'owner.json'), {
      pid: process.pid,
      ts: new Date().toISOString(),
      op: `claim:${op}`,
      token,
    });
    return ownsLease(claim, token) ? { path: claim, token } : null;
  } catch (error) {
    if (!LOCK_CONTENTION_CODES.has(error.code)) throw error;
    if (error.code !== 'EEXIST') return null;
  }

  const observed = readLeaseOwner(claim);
  if (!leaseDirectoryIsStale(claim, observed, staleLockMs)) return null;

  const observedToken = observed?.token ?? 'missing';
  const garbage = path.join(root, `.lock-claim-stale-${observedToken}-${crypto.randomBytes(6).toString('hex')}`);
  try {
    fs.renameSync(claim, garbage);
  } catch (error) {
    // 另一个竞争者先完成 rename 或 Windows 正在释放句柄，都只是本轮未取得。
    if (LOCK_CONTENTION_CODES.has(error.code)) return null;
    throw error;
  }

  const moved = readLeaseOwner(garbage);
  if ((moved?.token ?? 'missing') !== observedToken) {
    // ABA：被搬走的是后来者。能原位恢复就恢复；否则后来者会因 token 校验失败而退出。
    try {
      fs.renameSync(garbage, claim);
    } catch (error) {
      if (!LOCK_CONTENTION_CODES.has(error.code)) throw error;
    }
    return null;
  }

  try {
    fs.mkdirSync(claim);
  } catch (error) {
    retryWindows(() => fs.rmSync(garbage, { recursive: true, force: true }));
    if (LOCK_CONTENTION_CODES.has(error.code)) return null;
    throw error;
  }
  writeOwner(path.join(claim, 'owner.json'), {
    pid: process.pid,
    ts: new Date().toISOString(),
    op: `claim:${op}`,
    token,
  });
  retryWindows(() => fs.rmSync(garbage, { recursive: true, force: true }));
  return ownsLease(claim, token) ? { path: claim, token } : null;
}

function releaseClaim(lease) {
  if (!lease || !ownsLease(lease.path, lease.token)) return false;
  retryWindows(() => fs.rmSync(lease.path, { recursive: true, force: true }));
  return true;
}

function acquireClaimWithBackoff(root, op, delays, staleLockMs, deadline) {
  let attempt = 0;
  while (Date.now() < deadline) {
    const delay = delays[attempt % delays.length];
    const remaining = deadline - Date.now();
    sleepSync(Math.min(delay, Math.max(0, remaining)));
    try {
      const lease = tryAcquireClaim(root, op, staleLockMs);
      if (lease) return lease;
    } catch (error) {
      if (!LOCK_CONTENTION_CODES.has(error.code)) throw error;
    }
    attempt += 1;
  }
  return null;
}

function markWaiter(waiter, op, token) {
  writeOwner(waiter, { pid: process.pid, ts: new Date().toISOString(), op, token });
}

function liveWaiters(root, staleLockMs) {
  const waiters = [];
  for (const name of fs.readdirSync(root)) {
    if (!name.startsWith('.lock-waiter-')) continue;
    const file = path.join(root, name);
    // Windows 上 waiter 文件正被别的进程写/删时，readFileSync 与 statSync 会抛
    // EPERM/EACCES/EBUSY，而不是 ENOENT。这类竞态在 2026-11-02 的一次满负载 A3b 里
    // 以「waiter 读取 EPERM」的形式漏到测试外，整个写入因此失败。
    // 判据：读不到就当它不存活——最坏后果只是少让出一次 handoff，而不是写失败。
    let owner = null;
    try {
      owner = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      if (!LOCK_CONTENTION_CODES.has(error.code) && !(error instanceof SyntaxError)) throw error;
    }
    if (!owner) {
      let stat;
      try {
        stat = fs.statSync(file);
      } catch (error) {
        if (LOCK_CONTENTION_CODES.has(error.code)) continue;
        throw error;
      }
      if (Date.now() - stat.mtimeMs <= staleLockMs) {
        owner = { ts: stat.mtime.toISOString(), token: name.split('-').at(-1) };
      }
    }
    if (!owner || isStale(owner, staleLockMs)) {
      fs.rmSync(file, { force: true });
    } else {
      waiters.push({ file, owner });
    }
  }
  return waiters.sort((left, right) => (
    Date.parse(left.owner.ts) - Date.parse(right.owner.ts)
    || left.owner.token.localeCompare(right.owner.token)
  ));
}

function acquireDirectoryLock(root, op, options) {
  const delays = options.retryDelaysMs ?? DEFAULTS.retryDelaysMs;
  const staleLockMs = options.staleLockMs ?? DEFAULTS.staleLockMs;
  const maxWaitMs = options.lockMaxWaitMs ?? DEFAULTS.lockMaxWaitMs;
  const startedAt = Date.now();
  const deadline = startedAt + maxWaitMs;
  const lock = path.join(root, '.lock');
  const waiterToken = crypto.randomBytes(16).toString('hex');
  const waiter = path.join(root, `.lock-waiter-${process.pid}-${waiterToken}`);
  let lastOwner = null;
  let attempt = 0;

  try {
    if (options.skipIf?.()) return { skipped: true };
    // 先登记等待者，但不做严格 FIFO：短命进程可能被 OS 暂停，排队会让所有后来者一起空等。
    markWaiter(waiter, op, waiterToken);
    while (Date.now() < deadline) {
      if (options.skipIf?.()) return { skipped: true };
      const delay = delays[attempt % delays.length];
      sleepSync(Math.min(delay, Math.max(0, deadline - Date.now())));
      attempt += 1;
      let claim = null;
      try {
        // 活跃主锁可无锁观察；此时不争 claim，给持锁者的释放路径绝对优先权。
        lastOwner = readOwner(root);
        if (lastOwner && !isStale(lastOwner, staleLockMs)) continue;
        claim = acquireClaimWithBackoff(root, op, delays, staleLockMs, deadline);
        if (!claim) continue;
        if (!ownsLease(claim.path, claim.token)) continue;
        try {
          fs.mkdirSync(lock);
          const token = crypto.randomBytes(16).toString('hex');
          writeOwner(ownerFile(root), { pid: process.pid, ts: new Date().toISOString(), op, token });
          return { token, stolen: false };
        } catch (error) {
          if (!LOCK_CONTENTION_CODES.has(error.code)) throw error;
          if (error.code !== 'EEXIST') continue;
        }

        lastOwner = readOwner(root);
        if (!isStale(lastOwner, staleLockMs)) {
          continue;
        }

        // 抢占前先持有独立 claim 锁，再把旧租约改名。这样“读到旧 token 后，
        // 原持有者释放、新持有者重建”的 ABA 窗口里不会误删新租约。
        const observedToken = lastOwner?.token ?? 'missing';
        const garbage = path.join(root, `.lock-stale-${observedToken}-${crypto.randomBytes(6).toString('hex')}`);
        try {
          fs.renameSync(lock, garbage);
        } catch (error) {
          if (LOCK_CONTENTION_CODES.has(error.code)) continue;
          throw error;
        }

        // 与 liveWaiters 同理：刚 rename 过来的 owner.json 可能正被杀软/另一进程短暂占用，
        // 这里的读取竞态不该让整个写入失败——读不出来就当 token 不符，本轮跳过抢占。
        let movedOwner = null;
        try {
          movedOwner = JSON.parse(fs.readFileSync(path.join(garbage, 'owner.json'), 'utf8'));
        } catch (error) {
          if (!LOCK_CONTENTION_CODES.has(error.code) && !(error instanceof SyntaxError)) throw error;
        }
        if ((movedOwner?.token ?? 'missing') !== observedToken) {
          // claim 锁让这里通常不可达；保留校验，避免未来改锁协议时重新引入 ABA。
          if (!fs.existsSync(lock)) fs.renameSync(garbage, lock);
          continue;
        }

        try {
          fs.mkdirSync(lock);
        } catch (error) {
          // 初始化器可能只在首次建库时补出空锁目录；它没有 owner，不代表第二个持有者。
          if (error.code === 'EEXIST') {
            retryWindows(() => fs.rmSync(garbage, { recursive: true, force: true }));
            continue;
          }
          throw error;
        }
        const token = crypto.randomBytes(16).toString('hex');
        writeOwner(ownerFile(root), { pid: process.pid, ts: new Date().toISOString(), op, token });
        retryWindows(() => fs.rmSync(garbage, { recursive: true, force: true }));
        // 初始化阶段允许存在一个没有 owner 的空目录；清掉它不算抢占。
        return { token, stolen: Boolean(movedOwner) };
      } catch (error) {
        // claim/主锁的 EEXIST 都是正常竞争；只由外层五档退避决定最终超时。
        if (!LOCK_CONTENTION_CODES.has(error.code)) throw error;
      } finally {
        releaseClaim(claim);
      }
    }

    const waitedMs = Date.now() - startedAt;
    throw new MemoryError(
      'E_LOCK_TIMEOUT',
      `等待记忆锁 ${waitedMs}ms 后超时；最后持有者 pid=${lastOwner?.pid ?? '未知'} op=${lastOwner?.op ?? '未知'}`,
      { waitedMs, owner: lastOwner },
    );
  } finally {
    fs.rmSync(waiter, { force: true });
  }
}

function releaseDirectoryLock(
  root,
  token,
  handoffMs = DEFAULTS.handoffMs,
  delays = DEFAULTS.retryDelaysMs,
  staleLockMs = DEFAULTS.staleLockMs,
  maxWaitMs = DEFAULTS.lockMaxWaitMs,
) {
  const lock = path.join(root, '.lock');
  const startedAt = Date.now();
  const claim = acquireClaimWithBackoff(
    root,
    'release',
    delays,
    staleLockMs,
    startedAt + maxWaitMs,
  );
  if (!claim) {
    const owner = readLeaseOwner(path.join(root, '.lock-claim'));
    throw new MemoryError(
      'E_LOCK_TIMEOUT',
      `释放主锁等待 claim ${Date.now() - startedAt}ms 后超时；最后持有者 pid=${owner?.pid ?? '未知'} op=${owner?.op ?? '未知'}`,
      { waitedMs: Date.now() - startedAt, owner },
    );
  }
  let hasWaiter = false;
  try {
    if (!ownsLease(claim.path, claim.token)) return false;
    const owner = readOwner(root);
    // token 是租约身份而不是装饰字段；旧持有者绝不能释放后来者的锁。
    if (owner?.token !== token) return false;
    hasWaiter = liveWaiters(root, staleLockMs).length > 0;
    retryWindows(() => fs.rmSync(lock, { recursive: true, force: true }));
  } finally {
    releaseClaim(claim);
  }
  if (hasWaiter) sleepSync(handoffMs);
  return true;
}

export async function withLock(root, op, task, options = {}) {
  return mutexFor(root).run(async () => {
    const lease = acquireDirectoryLock(root, op, options);
    if (lease.skipped) return undefined;
    try {
      if (lease.stolen) {
        updateHealth(root, (health) => ({
          ...health,
          lock_stolen: (health.lock_stolen ?? 0) + 1,
        }));
      }
      return await task({ stolen: lease.stolen, token: lease.token });
    } finally {
      releaseDirectoryLock(
        root,
        lease.token,
        options.handoffMs,
        options.retryDelaysMs,
        options.staleLockMs,
        options.lockMaxWaitMs,
      );
    }
  });
}

export const __testing = Object.freeze({ isStale, releaseDirectoryLock });
