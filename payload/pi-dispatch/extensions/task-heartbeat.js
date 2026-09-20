const INTERVAL_MS = 10000;
const STALE_AFTER_MS = 30000;

const asTimestamp = (value) => (value === null ? null : new Date(value).toISOString());

export function createTaskHeartbeat({
  now = Date.now,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  let lifecycle = "not-started";
  let lastBeatAt = null;
  let sequence = 0;
  let lastProgressAt = null;
  let timer = null;
  let timerActive = false;
  let stoppedSnapshot = null;

  const readNow = () => Number(now());

  const beat = () => {
    if (lifecycle !== "started") return;
    lastBeatAt = readNow();
    sequence += 1;
  };

  const makeSnapshot = (at) => {
    const ageMs = lastBeatAt === null ? null : Math.max(0, at - lastBeatAt);
    const progressAgeMs = lastProgressAt === null
      ? null
      : Math.max(0, at - lastProgressAt);
    const status = lifecycle === "started"
      ? (ageMs > STALE_AFTER_MS ? "stale" : "fresh")
      : lifecycle;

    return {
      source: "gateway-supervisor",
      modelCalls: 0,
      status,
      intervalMs: INTERVAL_MS,
      staleAfterMs: STALE_AFTER_MS,
      lastBeatAt: asTimestamp(lastBeatAt),
      ageMs,
      sequence,
      lastProgressAt: asTimestamp(lastProgressAt),
      progressAgeMs,
    };
  };

  const start = () => {
    if (lifecycle !== "not-started") return;
    lifecycle = "started";
    beat();
    timer = setIntervalFn(beat, INTERVAL_MS);
    timerActive = true;
    if (timer && typeof timer.unref === "function") timer.unref();
  };

  const progress = () => {
    if (lifecycle === "started") lastProgressAt = readNow();
  };

  const stop = () => {
    if (lifecycle === "stopped") return;
    lifecycle = "stopped";
    if (timerActive) {
      clearIntervalFn(timer);
      timerActive = false;
      timer = null;
    }
    stoppedSnapshot = makeSnapshot(lastBeatAt === null ? null : readNow());
  };

  const snapshot = () => {
    if (stoppedSnapshot !== null) return { ...stoppedSnapshot };
    const at = lastBeatAt === null && lastProgressAt === null ? null : readNow();
    return makeSnapshot(at);
  };

  return { start, progress, stop, snapshot };
}
