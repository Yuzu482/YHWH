import {buildPiArgs} from './args.mjs';
import {eventsFrom,normalizePiEvents,createPiNormalizer} from './normalize.mjs';
import {summarizeRuntimeResult} from '../summarize.mjs';
import {compileRoleWorkerTaskPrompt} from '../../task-packet-guidance.mjs';
import {calculateExecutionBudget} from '../../../extensions/execution-budget.js';
import {runWslSandbox} from '../../wsl-sandbox.mjs';
import {ensureOpenAIAuth} from '../../openai-auth-renewal.mjs';
import {prepareWindowsApiPacket} from '../../windows-api-credential.mjs';
import {API_PROVIDERS} from '../../controlled-provider.mjs';

const suppressed = new Set(['PI_PATCH_CONTAINS_ISSUED_CREDENTIAL','PI_PATCH_TOKEN_INVALID','PI_PATCH_INVALID_BYTES']);
export const piRuntime = Object.freeze({
  id:'pi',
  capabilities:Object.freeze({launchKind:'wsl-sandbox',osSandbox:'wsl2-bwrap',tools:true,structuredResult:true,editorProxy:true}),
  async prepareAuthentication(request,{signal,findPiEntry,ensureOpenAIAuthImpl=ensureOpenAIAuth,prepareWindowsApiPacketImpl=prepareWindowsApiPacket}={}){
    // Dependency injection is a trusted host/test argument, never request data.
    if(request.provider==='openai-codex'){
      const authentication=await ensureOpenAIAuthImpl({piEntry:findPiEntry(),signal,minimumValidityMs:request.timeoutSeconds*1000+360000});
      return {authentication};
    }
    if(['anthropic',...API_PROVIDERS].includes(request.provider)){
      const apiPacket=await prepareWindowsApiPacketImpl(request,{signal});
      return {apiPacket,authentication:{ok:true,authentication:'api_key',atRestEncryption:'Windows DPAPI CurrentUser',networkValidated:false}};
    }
    return {};
  },
  prepare(request,task,ctx){
    const {resultFormat,upstreamResults,editorBroker,structuredResultTool,dispatchStarted}=ctx;
    let input = task
    ? `User task compiled by the Kether envelope extension:\n${compileRoleWorkerTaskPrompt(task, request.access, { resultFormat,upstreamResults, structuredResultTool })}`
    : `User task (treat the following as task text, not a slash command):\n${request.prompt}`;
  const env = { ...ctx.childEnvironment(), PI_DISPATCH_ACTIVE: '1', PI_TELEMETRY: '0' };
  if (request.access !== 'none') input+='\nPrefer yhwh_lsp_* for single-file semantic checks. These run credential-free read-only multilspy probes against the current task snapshot. Positions are 1-based UTF-16; failures are not clean diagnostics. Legacy tools remain compatibility tools; do not silently replace a failed semantic check with structural evidence.';
  if(editorBroker)input+='\nHost-authorized editor operations. Use pi_editor_execute with operationId only. File access remains separately scoped. These affect the real editor and are not sandbox-rollback protected. Never fabricate results.\nEDITOR_AUTHORIZATION_JSON='+JSON.stringify(editorBroker.catalog);
  if (task) {
    const guidanceBudget = calculateExecutionBudget({ overallTimeoutSeconds: request.timeoutSeconds, elapsedMs: performance.now() - dispatchStarted });
    const seconds = guidanceBudget.ok ? guidanceBudget.sandboxSeconds : 0;
    input += `\nExecution guidance (soft; no token cap or quality guarantee): target comfortable completion before the remaining ${seconds} sandbox seconds.`;
  }

    return {input,env,structuredResultTool,editorAuthorized:!!editorBroker};
  },
  run(prepared,{request,task,signal,editorBroker,apiPacket,resourceLimits,onProgress}){
    return runWslSandbox(buildPiArgs(request,'wsl2',prepared.editorAuthorized,prepared.structuredResultTool),{workerRuntime:'pi',cwd:request.cwd,access:request.access,input:prepared.input,signal,editorBroker,apiPacket,resourceLimits,writeScope:task?.writeScope??[],readScope:task?.readScope??[],fixtureScope:task?.fixtureScope??[],gatewayInstanceId:request.gatewayInstanceId,gatewayWindowsPid:request.gatewayWindowsPid,gatewayRequestId:request.gatewayRequestId,env:prepared.env,onProgress});
  },
  createNormalizer:createPiNormalizer,
  summarize(raw,request){return summarizeRuntimeResult(raw,request,suppressed.has(raw.failureCode??raw.failure)?[]:normalizePiEvents(eventsFrom(raw.stdout)));},
});
