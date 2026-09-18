const MIB = 1024 * 1024;

// The fixed profiles are the only tuning surface exposed to Tifereth.
// Callers may select a profile and shorten its runtime, but cannot send raw OS limits.
export const RESOURCE_PROFILES = Object.freeze({
  small: Object.freeze({ memoryBytes: 1024 * MIB, cpuQuotaMicros: 50_000, cpuPeriodMicros: 100_000, pidsMax: 64, outputBytes: MIB, maxRunSeconds: 120 }),
  standard: Object.freeze({ memoryBytes: 3 * 1024 * MIB, cpuQuotaMicros: 100_000, cpuPeriodMicros: 100_000, pidsMax: 128, outputBytes: 4 * MIB, maxRunSeconds: 300 }),
  large: Object.freeze({ memoryBytes: 6 * 1024 * MIB, cpuQuotaMicros: 200_000, cpuPeriodMicros: 100_000, pidsMax: 256, outputBytes: 8 * MIB, maxRunSeconds: 900 }),
});

export const DEFAULT_RESOURCE_PROFILE = 'standard';

export function resolveResourceLimits(profile = DEFAULT_RESOURCE_PROFILE, requestedTimeoutSeconds) {
  if (!Object.hasOwn(RESOURCE_PROFILES, profile)) throw new Error('resourceProfile must be small, standard, or large');
  const limits = RESOURCE_PROFILES[profile];
  if (requestedTimeoutSeconds !== undefined && (!Number.isInteger(requestedTimeoutSeconds) || requestedTimeoutSeconds < 1)) {
    throw new Error('timeoutSeconds must be a positive integer');
  }
  return Object.freeze({ profile, ...limits, timeoutSeconds: Math.min(requestedTimeoutSeconds ?? limits.maxRunSeconds, limits.maxRunSeconds) });
}

export function publicResourceProfiles() {
  return Object.fromEntries(Object.entries(RESOURCE_PROFILES).map(([name, limits]) => [name, {
    memoryMiB: limits.memoryBytes / MIB,
    cpuCores: limits.cpuQuotaMicros / limits.cpuPeriodMicros,
    pidsMax: limits.pidsMax,
    outputMiB: limits.outputBytes / MIB,
    maxRunSeconds: limits.maxRunSeconds,
  }]));
}
