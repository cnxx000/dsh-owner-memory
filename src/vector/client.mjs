import { Worker } from 'node:worker_threads';
import { modelDirectory } from './constants.mjs';

export class VectorClient {
  constructor({
    startupTimeoutMs = 3_000,
    idleTimeoutMs = 5 * 60_000,
    modelDir = modelDirectory(),
  } = {}) {
    this.startupTimeoutMs = startupTimeoutMs;
    this.idleTimeoutMs = idleTimeoutMs;
    this.modelDir = modelDir;
    this.worker = null;
    this.startup = null;
    this.startupResolve = null;
    this.current = null;
    this.queue = Promise.resolve();
    this.disabledReason = null;
    this.stopping = false;
    this.idleTimer = null;
    this.exitHandler = () => {
      this.stopping = true;
      this.worker?.terminate();
    };
    process.once('exit', this.exitHandler);
  }

  get disabled() {
    return this.disabledReason !== null;
  }

  disable(reason) {
    if (this.disabled) return;
    this.disabledReason = reason || 'vector worker failed';
    this.clearIdleTimer();
    this.startupResolve?.(false);
    this.startupResolve = null;
    this.current?.resolve(null);
    this.current = null;
    this.worker?.terminate();
    this.worker = null;
  }

  clearIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  scheduleIdleDispose() {
    this.clearIdleTimer();
    if (!(this.idleTimeoutMs > 0) || !this.worker) return;
    this.idleTimer = setTimeout(() => {
      this.dispose().catch(() => {});
    }, this.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  start() {
    if (this.disabled) return Promise.resolve(false);
    if (this.startup) return this.startup;

    this.stopping = false;
    const worker = new Worker(new URL('./worker.mjs', import.meta.url), {
      type: 'module',
      workerData: { modelDir: this.modelDir },
    });
    this.worker = worker;
    this.startup = new Promise((resolve) => {
      this.startupResolve = resolve;
      const timer = setTimeout(() => {
        this.disable(`vector worker startup timed out after ${this.startupTimeoutMs}ms`);
        resolve(false);
      }, this.startupTimeoutMs);

      worker.on('message', (message) => {
        if (Array.isArray(message)) {
          const pending = this.current;
          this.current = null;
          pending?.resolve(message);
          return;
        }
        if (message?.type === 'ready') {
          clearTimeout(timer);
          this.startupResolve = null;
          resolve(true);
          return;
        }
        if (message?.type === 'failed') {
          clearTimeout(timer);
          this.disable(message.reason);
          resolve(false);
        }
      });
      worker.once('error', (error) => {
        clearTimeout(timer);
        this.disable(error?.message ?? String(error));
        resolve(false);
      });
      worker.once('exit', (code) => {
        if (this.worker === worker) this.worker = null;
        if (!this.stopping && !this.disabled && this.worker === null) {
          this.disable(`vector worker exited with code ${code}`);
        }
      });
      // Adding a message listener refs the underlying MessagePort again, so
      // unref only after all listeners are installed.
      worker.unref();
    });
    return this.startup;
  }

  async encode(texts, { query = false } = {}) {
    if (this.disabled) return null;
    if (!Array.isArray(texts)) throw new TypeError('texts must be an array');
    if (texts.length === 0) return [];
    this.clearIdleTimer();

    const operation = this.queue.then(async () => {
      this.clearIdleTimer();
      const starting = this.start();
      // An active request must keep short-lived CLIs alive; after it settles
      // the worker returns to unref'ed idle state.
      this.worker?.ref();
      try {
        if (!await starting) return null;
        if (this.disabled || !this.worker) return null;
        return await new Promise((resolve) => {
          this.current = { resolve };
          this.worker.postMessage({
            type: 'encode',
            texts: texts.map(String),
            ...(query ? { query: true } : {}),
          });
        });
      } finally {
        this.worker?.unref();
      }
    });
    this.queue = operation.catch(() => null).finally(() => this.scheduleIdleDispose());
    return operation;
  }

  async dispose() {
    this.clearIdleTimer();
    this.stopping = true;
    this.startupResolve?.(false);
    this.startupResolve = null;
    this.current?.resolve(null);
    this.current = null;
    const worker = this.worker;
    this.worker = null;
    if (worker) await worker.terminate();
    this.startup = null;
    this.queue = Promise.resolve();
    this.stopping = false;
  }

  async close() {
    process.removeListener('exit', this.exitHandler);
    await this.dispose();
  }
}

export const vectorClient = new VectorClient();
const clients = new Map([[vectorClient.modelDir, vectorClient]]);

export function vectorClientFor({ modelDir = modelDirectory() } = {}) {
  let client = clients.get(modelDir);
  if (!client) {
    client = new VectorClient({ modelDir });
    clients.set(modelDir, client);
  }
  return client;
}

export async function disposeVectorClients() {
  await Promise.all([...clients.values()].map((client) => client.dispose()));
}

export function encodeVectors(texts, options) {
  return vectorClient.encode(texts, options);
}

export function vectorDisabledReason() {
  return vectorClient.disabledReason;
}
