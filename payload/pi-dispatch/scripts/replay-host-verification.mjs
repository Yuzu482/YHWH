import {createHash} from 'node:crypto';
import {mkdtemp, readFile, rm, writeFile, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const PATCH_PATH = resolve(fileURLToPath(new URL('../../../.test/od8445-chesed-2.patch', import.meta.url)));
const NO_PRODUCTION_PATH = /(?:^|\/)(?:\.pi|ledger|open-design)(?:\/|$)/i;

/** Classify a durable gateway final result using explicit gateway signals only. */
export function classifyGatewayReplay(finalResult) {
  const response = finalResult?.result?.response ?? finalResult?.response ?? finalResult;
  if (response?.hostVerification?.state === 'awaiting-host-verification' ||
      response?.status === 'awaiting-host-verification' ||
      response?.failure === 'awaiting-host-verification') {
    return 'awaiting-host-verification';
  }
  // Explicit response status or failure takes precedence over the persisted state.
  return response?.status ?? response?.failure ?? finalResult?.state ?? 'unknown';
}

/**
 * A bounded replay model, not a command runner. The original patch is retained
 * byte-for-byte as an input artifact in the temporary fixture. Check outcomes
 * below are labelled fixture observations and must not be presented as host runs.
 */
export async function replayHostVerification({patchPath = PATCH_PATH, tempRoot = tmpdir()} = {}) {
  const patch = await readFile(patchPath);
  const originalDigest = sha256(patch);
  const root = await mkdtemp(join(tempRoot, 'fix23-host-replay-'));
  try {
    const fixture = join(root, 'fixture');
    const ledger = join(root, 'ledger');
    await mkdir(fixture);
    await mkdir(ledger);
    if (NO_PRODUCTION_PATH.test(resolve(root))) throw new Error('unsafe fixture location');

    // Keep the exact source patch and a separate fixture-only application record.
    await writeFile(join(fixture, 'original.patch'), patch, {flag: 'wx'});
    const originalApplied = Buffer.concat([Buffer.from('FIXTURE-APPLIED-PATCH\n'), patch]);
    await writeFile(join(fixture, 'original.applied'), originalApplied, {flag: 'wx'});
    const original = await attestFixture(ledger, 'original', originalDigest, [
      {checkName: 'focused-tests', exitCode: 0, summary: 'fixture observation: 19/19'},
      {checkName: 'typecheck', exitCode: 1, summary: 'fixture observation: TS2352 observed'},
      {checkName: 'build', exitCode: 0, summary: 'fixture observation: not used to override failed typecheck'},
    ]);

    // Distinct, explicitly one-line repair fixture; never edits the input patch.
    const repairLine = Buffer.from('\n// Luna fixture repair: narrow the disputed conversion.\n');
    const repairedApplied = Buffer.concat([originalApplied, repairLine]);
    const repairedDigest = sha256(repairedApplied);
    await writeFile(join(fixture, 'repaired.applied'), repairedApplied, {flag: 'wx'});
    const repaired = await attestFixture(ledger, 'repaired', repairedDigest, [
      {checkName: 'focused-tests', exitCode: 0, summary: 'fixture observation: 19/19'},
      {checkName: 'typecheck', exitCode: 0, summary: 'fixture observation: 0'},
      {checkName: 'build', exitCode: 0, summary: 'fixture observation: 0'},
    ]);

    if (originalDigest === repairedDigest || original.outcome !== 'failed' || repaired.outcome !== 'completed') {
      throw new Error('fixture replay invariant failed');
    }
    return {
      mode: 'isolated-fixture-model', executedHostCommands: false,
      fixtureRoot: root, productionWrites: false, original, repaired,
    };
  } catch (error) {
    await rm(root, {recursive: true, force: true});
    throw error;
  }
}

export async function createFixtureLedger(ledger) {
  return {
    async register(name, artifactSha256, requiredChecks) {
      if (!/^[a-f0-9]{64}$/.test(artifactSha256) || !Array.isArray(requiredChecks) || !requiredChecks.length) throw new Error('invalid pending binding');
      const pending = {state: 'awaiting-host-verification', name, artifactSha256, requiredChecks};
      await writeFile(join(ledger, `${name}.json`), JSON.stringify(pending), {flag: 'wx'});
      return pending;
    },
    async record(name, artifactSha256, commands) {
      const path = join(ledger, `${name}.json`);
      const pending = JSON.parse(await readFile(path, 'utf8'));
      if (pending.artifactSha256 !== artifactSha256) throw new Error('binding mismatch');
      if (!Array.isArray(commands) || commands.length !== pending.requiredChecks.length || commands.some(c => !pending.requiredChecks.includes(c.checkName) || !Number.isInteger(c.exitCode)) || new Set(commands.map(c => c.checkName)).size !== pending.requiredChecks.length) throw new Error('invalid or incomplete verification');
      const record = {artifactSha256, commands, outcome: commands.every(item => item.exitCode === 0) ? 'completed' : 'failed'};
      record.recordSha256 = sha256(JSON.stringify(record));
      if (pending.record) {
        if (pending.record.recordSha256 !== record.recordSha256) throw new Error('conflicting verification');
        return pending.record;
      }
      if (pending.state !== 'awaiting-host-verification') throw new Error('not pending');
      const durable = {...pending, state: record.outcome, record};
      const temp = `${path}.next`;
      await writeFile(temp, JSON.stringify(durable), {flag: 'wx'});
      const {rename} = await import('node:fs/promises');
      await rename(temp, path);
      return record;
    },
    async get(name, artifactSha256, recordSha256) {
      try {
        const value = JSON.parse(await readFile(join(ledger, `${name}.json`), 'utf8'));
        if (!value.record || value.artifactSha256 !== artifactSha256 || value.record.artifactSha256 !== artifactSha256 || value.record.recordSha256 !== recordSha256) return null;
        const {recordSha256: digest, ...body} = value.record;
        return sha256(JSON.stringify(body)) === digest ? value.record : null;
      } catch { return null; }
    },
  };
}

async function attestFixture(ledger, name, artifactSha256, commands) {
  const api = await createFixtureLedger(ledger);
  const pending = await api.register(name, artifactSha256, commands.map(c => c.checkName));
  const before = JSON.parse(await readFile(join(ledger, `${name}.json`), 'utf8'));
  if (before.state !== 'awaiting-host-verification') throw new Error('fixture did not reach pending');
  const record = await api.record(name, artifactSha256, commands);
  const readback = await api.get(name, artifactSha256, record.recordSha256);
  if (!readback || readback.artifactSha256 !== artifactSha256 || readback.outcome !== record.outcome) throw new Error('fixture attestation binding mismatch');
  return {name, artifactSha256, recordSha256: record.recordSha256, pendingState: pending.state, outcome: record.outcome, commands};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await replayHostVerification();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
