export function calculateExecutionBudget({ overallTimeoutSeconds, elapsedMs = 0 }) {
  const validTimeout = Number.isInteger(overallTimeoutSeconds) && overallTimeoutSeconds >= 1;
  const validElapsed = Number.isFinite(elapsedMs) && elapsedMs >= 0;
  if (!validTimeout || !validElapsed) {
    return { ok: false, overallTimeoutSeconds, elapsedMs, reserveSeconds: null, sandboxSeconds: 0 };
  }
  const reserveSeconds = Math.min(15, overallTimeoutSeconds * 0.1);
  const sandboxSeconds = Math.floor(overallTimeoutSeconds - elapsedMs / 1000 - reserveSeconds);
  return { ok: sandboxSeconds >= 1, overallTimeoutSeconds, elapsedMs, reserveSeconds, sandboxSeconds };
}
