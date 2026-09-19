import { freemem, totalmem } from 'node:os';

const GIB = 1024 ** 3;

export const SCHEDULER_POLICY = Object.freeze({
  maxConcurrency: 4,
  memoryCapacityBytes: 6 * GIB,
  cpuCapacity: 2,
  hostReserveBytes: Math.max(2 * GIB, Math.ceil(totalmem() * 0.10)),
  providerCapacity: Object.freeze({ 'openai-codex': 2, 'anthropic': 1, 'opencode-go': 2, 'yhwh-worker-api': 2, 'yhwh-reviewer-api': 1 }),
  pollIntervalMs: 500,
  agingIntervalMs: 30_000,
  queueTimeoutMs: 120_000,
});

export class ResourceAwareExecutor {
  constructor(maxConcurrency = 4, maxQueue = 16, options = {}) {
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > SCHEDULER_POLICY.maxConcurrency) throw new Error('maxConcurrency must be an integer from 1 to 4');
    if (!Number.isInteger(maxQueue) || maxQueue < 1 || maxQueue > 64) throw new Error('maxQueue must be an integer from 1 to 64');
    this.maxConcurrency = maxConcurrency;
    this.maxQueue = maxQueue;
    this.memoryCapacityBytes = options.memoryCapacityBytes ?? SCHEDULER_POLICY.memoryCapacityBytes;
    this.cpuCapacity = options.cpuCapacity ?? SCHEDULER_POLICY.cpuCapacity;
    this.hostReserveBytes = options.hostReserveBytes ?? SCHEDULER_POLICY.hostReserveBytes;
    this.providerCapacity = { ...SCHEDULER_POLICY.providerCapacity, ...(options.providerCapacity || {}) };
    this.availableMemoryBytes = options.availableMemoryBytes ?? freemem;
    this.pollIntervalMs = options.pollIntervalMs ?? SCHEDULER_POLICY.pollIntervalMs;
    this.agingIntervalMs = options.agingIntervalMs ?? SCHEDULER_POLICY.agingIntervalMs;
    if (!Number.isInteger(this.agingIntervalMs) || this.agingIntervalMs < 1) throw new Error('agingIntervalMs must be a positive integer');
    this.accepting = true;
    this.active = 0;
    this.activeMemoryBytes = 0;
    this.activeCpu = 0;
    this.activeByProvider = {};
    this.queue = [];
    this.sequence = 0;
    this.pollTimer = null;
    this.activeControllers = new Set();
    this.idleWaiters = new Set();
  }

  get state() {
    const hostAvailableMemoryBytes = this.availableMemoryBytes();
    return {
      active: this.active,
      queued: this.queue.length,
      maxConcurrency: this.maxConcurrency,
      maxQueue: this.maxQueue,
      activeMemoryMiB: Math.ceil(this.activeMemoryBytes / 1024 / 1024),
      memoryCapacityMiB: this.memoryCapacityBytes / 1024 / 1024,
      activeCpu: this.activeCpu,
      cpuCapacity: this.cpuCapacity,
      hostMemoryReserveMiB: this.hostReserveBytes / 1024 / 1024,
      hostAvailableMemoryMiB: Math.floor(hostAvailableMemoryBytes / 1024 / 1024),
      schedulableMemoryMiB: Math.max(0, Math.floor(Math.min(
        this.memoryCapacityBytes - this.activeMemoryBytes,
        hostAvailableMemoryBytes - this.hostReserveBytes,
      ) / 1024 / 1024)),
      activeByProvider: { ...this.activeByProvider },
      providerCapacity: { ...this.providerCapacity },
      accepting: this.accepting,
      agingIntervalMs: this.agingIntervalMs,
      gatewayRssMiB: Math.ceil(process.memoryUsage().rss / 1024 / 1024),
      hostAvailableMemoryIncludesGatewayAndWsl: true,
    };
  }

  run(fn, timeoutMs, parentSignal, scheduling = {}) {
    if (!this.accepting) return Promise.reject(new Error('gateway is shutting down'));
    if (parentSignal?.aborted) return Promise.reject(new Error('gateway request cancelled while queued'));
    if (this.queue.length >= this.maxQueue) return Promise.reject(new Error('gateway queue is full'));
    const queueTimeoutMs = scheduling.queueTimeoutMs ?? SCHEDULER_POLICY.queueTimeoutMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(queueTimeoutMs) || queueTimeoutMs <= 0) return Promise.reject(new Error('timeouts must be positive'));
    const deadline = Date.now() + queueTimeoutMs;
    return new Promise((resolvePromise, rejectPromise) => {
      const item = {
        fn, deadline, timeoutMs, parentSignal, resolvePromise, rejectPromise,
        onWaiting: scheduling.onWaiting, onTiming: scheduling.onTiming, waitReasons: [],
        priority: scheduling.priority ?? 5,
        provider: scheduling.provider,
        memoryBytes: scheduling.memoryBytes ?? 0,
        cpu: scheduling.cpu ?? 0,
        canRun: scheduling.canRun,
        acquire: scheduling.acquire,
        release: scheduling.release,
        sequence: this.sequence++, enqueuedAt: Date.now(), timer: null, abortQueued: null,
      };
      item.abortQueued = () => this.removeQueued(item, new Error('gateway request cancelled while queued'));
      parentSignal?.addEventListener('abort', item.abortQueued, { once: true });
      item.timer = setTimeout(() => this.removeQueued(item, Object.assign(new Error('gateway request timed out while queued'), {code:'QUEUE_TIMEOUT', waitReasons:item.waitReasons})), queueTimeoutMs);
      this.queue.push(item);
      this.pump();
    });
  }

  removeQueued(item, error) {
    const index = this.queue.indexOf(item);
    if (index < 0) return;
    this.queue.splice(index, 1);
    clearTimeout(item.timer);
    item.parentSignal?.removeEventListener('abort', item.abortQueued);
    item.onTiming?.({queueWaitMs:Date.now()-item.enqueuedAt,executionMs:0});
    item.rejectPromise(error);
  }

  schedulePoll() {
    if (this.pollTimer || !this.queue.length) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      this.pump();
    }, this.pollIntervalMs);
    this.pollTimer.unref?.();
  }

  fits(item) {
    return this.capacityReasons(item).length === 0;
  }

  capacityReasons(item) {
    const reasons = [];
    const providerLimit = this.providerCapacity[item.provider] ?? this.maxConcurrency;
    if (this.active >= this.maxConcurrency) reasons.push('concurrency');
    if ((this.activeByProvider[item.provider] || 0) >= providerLimit) reasons.push('provider_capacity');
    if (this.activeMemoryBytes + item.memoryBytes > this.memoryCapacityBytes) reasons.push('memory_capacity');
    if (this.activeCpu + item.cpu > this.cpuCapacity + Number.EPSILON) reasons.push('cpu_capacity');
    if (this.availableMemoryBytes() < item.memoryBytes + this.hostReserveBytes) reasons.push('host_memory');
    return reasons;
  }

  waiting(item, reasons) {
    item.waitReasons = reasons;
    item.onWaiting?.({waitReasons:[...reasons],queueDeadlineAt:new Date(item.deadline).toISOString(),executionTimeoutMs:item.timeoutMs});
  }

  nextRunnable() {
    const now = Date.now();
    const effectivePriority = item => Math.min(9, item.priority + Math.floor((now - item.enqueuedAt) / this.agingIntervalMs));
    const ordered = [...this.queue].sort((a, b) => effectivePriority(b) - effectivePriority(a) || a.sequence - b.sequence);
    for (const item of ordered) {
      try {
        if (Date.now() >= item.deadline) { this.removeQueued(item,Object.assign(new Error('gateway request timed out while queued'),{code:'QUEUE_TIMEOUT',waitReasons:item.waitReasons})); continue; }
        const reasons = this.capacityReasons(item);
        if (item.canRun && !item.canRun()) reasons.push('dependency');
        if (reasons.length) { this.waiting(item,reasons); continue; }
        const lock = item.acquire ? item.acquire() : true;
        if (!lock) { this.waiting(item,['write_lock']); continue; }
        return { index: this.queue.indexOf(item), lock };
      } catch (error) {
        this.removeQueued(item, error);
      }
    }
    return null;
  }

  pump() {
    while (this.queue.length) {
      const selected = this.nextRunnable();
      if (!selected) { this.schedulePoll(); break; }
      const [item] = this.queue.splice(selected.index, 1);
      clearTimeout(item.timer);
      item.parentSignal?.removeEventListener('abort', item.abortQueued);
      if (item.deadline <= Date.now()) {
        if (item.release && selected.lock !== true) item.release(selected.lock);
        item.rejectPromise(new Error('gateway request timed out while queued'));
        continue;
      }
      this.active++;
      this.activeMemoryBytes += item.memoryBytes;
      this.activeCpu += item.cpu;
      if (item.provider) this.activeByProvider[item.provider] = (this.activeByProvider[item.provider] || 0) + 1;
      const controller = new AbortController();
      this.activeControllers.add(controller);
      const abort = () => controller.abort();
      item.parentSignal?.addEventListener('abort', abort, { once: true });
      const startedAt = Date.now();
      const timing = () => ({queueWaitMs:startedAt-item.enqueuedAt,executionMs:Date.now()-startedAt});
      let executionTimedOut = false;
      const timer = setTimeout(() => { executionTimedOut=true; controller.abort(); }, item.timeoutMs);
      Promise.resolve().then(() => item.fn(controller.signal, Math.max(1, Math.ceil(item.timeoutMs / 1000))))
        .then(value => {
          item.onTiming?.(timing());
          if (executionTimedOut) throw Object.assign(new Error('gateway execution timed out'),{code:'EXECUTION_TIMEOUT'});
          return value;
        }, error => {
          item.onTiming?.(timing());
          if (executionTimedOut) throw Object.assign(new Error('gateway execution timed out'),{code:'EXECUTION_TIMEOUT'});
          throw error;
        }).then(item.resolvePromise, item.rejectPromise)
        .finally(() => {
          clearTimeout(timer);
          item.parentSignal?.removeEventListener('abort', abort);
          if (item.release && selected.lock !== true) item.release(selected.lock);
          this.active--;
          this.activeMemoryBytes -= item.memoryBytes;
          this.activeCpu -= item.cpu;
          if (item.provider) {
            this.activeByProvider[item.provider]--;
            if (this.activeByProvider[item.provider] === 0) delete this.activeByProvider[item.provider];
          }
          this.activeControllers.delete(controller);
          if (this.active === 0) {
            for (const waiter of this.idleWaiters) waiter();
            this.idleWaiters.clear();
          }
          this.pump();
        });
    }
  }

  waitForIdle(timeoutMs) {
    if (this.active === 0) return Promise.resolve(true);
    return new Promise(resolveWait => {
      let settled = false;
      const finish = value => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.idleWaiters.delete(onIdle);
        resolveWait(value);
      };
      const onIdle = () => finish(true);
      this.idleWaiters.add(onIdle);
      const timer = setTimeout(() => finish(false), timeoutMs);
      timer.unref?.();
    });
  }

  async shutdown({ graceMs = 10_000, abortWaitMs = 20_000 } = {}) {
    this.accepting = false;
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null; }
    const queuedCancelled = this.queue.length;
    for (const item of [...this.queue]) this.removeQueued(item, new Error('gateway shut down while request was queued'));
    const graceful = await this.waitForIdle(graceMs);
    const forced = graceful ? 0 : this.activeControllers.size;
    if (!graceful) {
      for (const controller of this.activeControllers) controller.abort();
      await this.waitForIdle(abortWaitMs);
    }
    return { queuedCancelled, forced, remainingActive: this.active, graceful: graceful && this.active === 0 };
  }
}
