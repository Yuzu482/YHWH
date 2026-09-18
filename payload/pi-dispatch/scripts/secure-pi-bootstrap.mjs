// FD 3 is opened by the root launcher outside the sandbox filesystem.
import { readFileSync, closeSync } from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
const data = JSON.parse(readFileSync(3, 'utf8'));
closeSync(3);
if (Object.keys(data).length !== 1) throw new Error('Expected one controlled credential');
if (data.claudeReview) {
  const args = process.argv.slice(2);
  const one = flag => args.filter(a => a === flag).length === 1;
  if (!one('--provider') || args[args.indexOf('--provider')+1] !== 'pi-claude-code-provider' ||
      !one('--model') || args[args.indexOf('--model')+1] !== 'claude-sonnet-5' ||
      !args.includes('--no-tools') || args.includes('--tools')) throw new Error('Invalid Claude review invocation');
  const credential = data.claudeReview;
  if (typeof credential.accessToken !== 'string' || !credential.accessToken ||
      !['pro','max','team','enterprise'].includes(credential.subscriptionType)) throw new Error('Missing eligible Claude credential');
  const executable = '/opt/pi-kether/node_modules/@anthropic-ai/claude-code/bin/claude.exe';
  const nativeExecFile = childProcess.execFile;
  const nativeSpawn = childProcess.spawn;
  const withToken = options => ({...options,env:{...options?.env,CLAUDE_CODE_OAUTH_TOKEN:credential.accessToken}});
  const exec = promisify(nativeExecFile);
  const env = {...process.env,CLAUDE_CODE_OAUTH_TOKEN:credential.accessToken,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'};
  const status = JSON.parse((await exec(executable,['auth','status'],{env,timeout:10000})).stdout);
  if (!status.loggedIn || status.authMethod !== 'oauth_token' || status.apiProvider !== 'firstParty') throw new Error('Claude OAuth preflight failed');
  const version = (await exec(executable,['--version'],{env,timeout:10000})).stdout.match(/\d+\.\d+\.\d+/)?.[0];
  if (!version) throw new Error('Claude version missing');
  // Secrets remain in this closure and enter only the trusted CLI environment.
  // Pi and unrelated tool subprocesses never receive them in process.env.
  childProcess.spawn = function(file,args,options) { return nativeSpawn(file,args,file === executable ? withToken(options) : options); };
  syncBuiltinESMExports();
  globalThis[Symbol.for('pi-kether.claude-installation')] = Object.freeze({executable,version,subscriptionType:credential.subscriptionType});
} else if (typeof data.openaiAccess?.accessToken!=='string'||!data.openaiAccess.accessToken||!Number.isFinite(data.openaiAccess.expiresAt)||data.openaiAccess.expiresAt<=Date.now()+300000) throw new Error('PI_AUTH_EXPIRED');
const { AuthStorage } = await import('/opt/pi-kether/node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js');
const store = AuthStorage.inMemory(data.claudeReview ? {} : {'openai-codex':{type:'oauth',access:data.openaiAccess.accessToken,expires:data.openaiAccess.expiresAt,refresh:''}});
// Host owns refresh and persistence. Never let task memory rotate credentials.
store.modify = async () => { throw new Error('PI_AUTH_RENEW_HOST_REQUIRED'); };
store.delete = async () => { throw new Error('PI_AUTH_RENEW_HOST_REQUIRED'); };
AuthStorage.create = () => store;
delete process.env.PI_SANDBOX_AUTH_PATH;
await import('/opt/pi-kether/node_modules/@earendil-works/pi-coding-agent/dist/cli.js');
