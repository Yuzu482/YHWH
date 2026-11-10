// Host-owned, nonsecret reviewer transport preference. Never read task/workspace config.
import { lstatSync, readFileSync } from 'node:fs';
import { join, resolve, isAbsolute, sep } from 'node:path';

export const REVIEWER_ROUTES = Object.freeze({
  'claude-code-cli': Object.freeze({model:'claude-sonnet-5',runtime:'claude-code-cli'}),
  anthropic: Object.freeze({model:'claude-sonnet-5',runtime:'pi'}),
  'openai-codex': Object.freeze({model:'gpt-6-sol',runtime:'pi'}),
});
export const REVIEWER_TRANSPORTS = Object.freeze(Object.keys(REVIEWER_ROUTES));
export function nativeReviewerRoute(provider) {
  if (!Object.hasOwn(REVIEWER_ROUTES, provider)) throw new Error('Unsupported native reviewer provider');
  return REVIEWER_ROUTES[provider];
}
// The legacy controlled API transport only implements max; never translate effort.
export function reviewerThinkingLevels(provider) {
  if (provider === 'yhwh-reviewer-api') return ['max'];
  nativeReviewerRoute(provider);
  return ['medium','high','xhigh'];
}
const fail = () => { throw Object.assign(new Error('PI_REVIEWER_ROUTE_CONFIG_INVALID'), { code: 'PI_REVIEWER_ROUTE_CONFIG_INVALID' }); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function validateReviewerRouteConfig(value) {
  if (!object(value) || Object.keys(value).some(key => !['schemaVersion', 'defaultTransport'].includes(key)) ||
      value.schemaVersion !== 1 || !REVIEWER_TRANSPORTS.includes(value.defaultTransport)) fail();
  return value;
}

export function loadReviewerRouteConfig(home = process.env.USERPROFILE ?? process.env.HOME) {
  if (typeof home !== 'string' || !home || !isAbsolute(home) || home.includes('\0')) fail();
  const root = resolve(home);
  const stateRoot = join(root, '.local', 'state', 'pi-kether');
  const file = join(stateRoot, 'reviewer-transport.json');
  if (!file.startsWith(root + sep)) fail();
  try {
    for (const directory of [join(root, '.local'), join(root, '.local', 'state'), stateRoot]) {
      try {
        const dirStat = lstatSync(directory);
        if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) fail();
      } catch (error) {
        if (error.code === 'ENOENT') return { schemaVersion: 1, defaultTransport: 'claude-code-cli' };
        throw error;
      }
    }
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) fail();
    return validateReviewerRouteConfig(JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')));
  } catch (error) {
    if (error.code === 'ENOENT') return { schemaVersion: 1, defaultTransport: 'claude-code-cli' };
    if (error.code === 'PI_REVIEWER_ROUTE_CONFIG_INVALID') throw error;
    fail();
  }
}

export function effectiveReviewerTransport(home) {
  return loadReviewerRouteConfig(home).defaultTransport;
}
