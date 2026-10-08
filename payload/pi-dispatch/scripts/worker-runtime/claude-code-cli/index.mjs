import {compileKetherTask} from '../../../extensions/kether-envelope.js';
import {roleResultSchema} from '../../../extensions/role-contract.js';
import {PROVIDER_POLICY} from '../../provider-policy.mjs';
export const claudeCliRuntime=Object.freeze({
  id:'claude-code-cli',capabilities:Object.freeze({launchKind:'host-cli',osSandbox:'none',tools:false,structuredResult:false,editorProxy:false}),
  prepare(request,task,{probe,probeToken,resultFormat}){return {packet:probe?`Return exactly ${probeToken} and nothing else.`:compileKetherTask(task,{resultFormat})};},
  run(prepared,{request,signal,context}){const {packet}=prepared;const {probe,claudeReviewerRunner,claudeCliEntryResolver,onModelStart}=context;
    return claudeReviewerRunner({ packet, nodePath: process.execPath, cliScript: claudeCliEntryResolver(), timeoutMs: request.timeoutSeconds * 1000, signal, thinking: request.thinking ?? PROVIDER_POLICY[request.provider]?.defaultThinking ?? 'medium', ...(!probe ? { resultSchema: roleResultSchema('Geburah') } : {}), ...(!probe && typeof onModelStart === 'function' ? { onModelStart } : {}) });
  },
  summarize(result,request){
    const failureCode = ['PI_AUTH_EXPIRED', 'PI_QUOTA_LIMITED'].includes(result.reason) ? result.reason : undefined;
    return {
      target: request.target, requestedProvider: request.provider, requestedModel: request.model,
      provider: request.provider, model: request.model, ok: result.status === 'completed',
      ...(result.text !== undefined ? { text: result.text } : {}), usage: result.usage ?? null, modelExecutionStarted: result.modelExecutionStarted === true,
      toolsUsed: [], toolErrors: 0, runtime: 'host-cli', osSandbox: 'none',
      ...(result.status !== 'completed' ? { failureCode: failureCode ?? result.reason, failure: failureCode ?? result.reason ?? 'Claude Code CLI failed' } : {}),
      ...(result.resetTime ? { resetTime: result.resetTime } : {}),
    };
  },
});
