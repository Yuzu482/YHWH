import {API_PROVIDERS} from '../controlled-provider.mjs';
import {piRuntime} from './pi/index.mjs';
import {claudeCliRuntime} from './claude-code-cli/index.mjs';
export const RUNTIMES=Object.freeze({pi:piRuntime,'claude-code-cli':claudeCliRuntime});
export function resolveRuntime(request){
  if(request?.provider==='claude-code-cli')return claudeCliRuntime;
  if(['openai-codex','anthropic',...API_PROVIDERS].includes(request?.provider))return piRuntime;
  throw new Error('provider is not in the Pi gateway allowlist');
}
// Dependency injection is a trusted host/test function argument, never a request/MCP field.
export async function executeRuntime(runtime,{request,task,signal,context}){
  const prepared=runtime.prepare(request,task,context);
  const raw=await runtime.run(prepared,{request,task,signal,context});
  return runtime.summarize(raw,request);
}
