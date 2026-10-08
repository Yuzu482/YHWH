const MIB = 1024 * 1024;
export const GLOBAL_MAX_RUN_SECONDS = 900;

// The fixed profiles are the only tuning surface exposed to Tifereth.
// Callers select fixed resource profiles; explicit runtime may extend defaults only to the global ceiling.
export const RESOURCE_PROFILES = Object.freeze({
  small: Object.freeze({ memoryBytes: 1024 * MIB, cpuQuotaMicros: 50_000, cpuPeriodMicros: 100_000, pidsMax: 64, outputBytes: MIB, defaultRunSeconds: 120, maxRunSeconds: GLOBAL_MAX_RUN_SECONDS }),
  standard: Object.freeze({ memoryBytes: 3 * 1024 * MIB, cpuQuotaMicros: 100_000, cpuPeriodMicros: 100_000, pidsMax: 128, outputBytes: 4 * MIB, defaultRunSeconds: 300, maxRunSeconds: GLOBAL_MAX_RUN_SECONDS }),
  large: Object.freeze({ memoryBytes: 6 * 1024 * MIB, cpuQuotaMicros: 200_000, cpuPeriodMicros: 100_000, pidsMax: 256, outputBytes: 8 * MIB, defaultRunSeconds: 900, maxRunSeconds: GLOBAL_MAX_RUN_SECONDS }),
});

export const DEFAULT_RESOURCE_PROFILE = 'standard';

export function resolveResourceLimits(profile = DEFAULT_RESOURCE_PROFILE, requestedTimeoutSeconds) {
  if (!Object.hasOwn(RESOURCE_PROFILES, profile)) throw new Error('resourceProfile must be small, standard, or large');
  const limits = RESOURCE_PROFILES[profile];
  if (requestedTimeoutSeconds !== undefined && (!Number.isInteger(requestedTimeoutSeconds) || requestedTimeoutSeconds < 1)) {
    throw new Error('timeoutSeconds must be a positive integer');
  }
  return Object.freeze({ profile, ...limits, timeoutSeconds: Math.min(requestedTimeoutSeconds ?? limits.defaultRunSeconds, GLOBAL_MAX_RUN_SECONDS) });
}

export function publicResourceProfiles() {
  return Object.fromEntries(Object.entries(RESOURCE_PROFILES).map(([name, limits]) => [name, {
    memoryMiB: limits.memoryBytes / MIB,
    cpuCores: limits.cpuQuotaMicros / limits.cpuPeriodMicros,
    pidsMax: limits.pidsMax,
    outputMiB: limits.outputBytes / MIB,
    defaultRunSeconds: limits.defaultRunSeconds,
    maxRunSeconds: limits.maxRunSeconds,
  }]));
}
