import {runWslSandbox} from './wsl-sandbox.mjs';

export const LSP_METHODS = Object.freeze({diagnostics:'lsp_diagnostics',hover:'lsp_hover',definition:'lsp_definition',references:'lsp_references',symbols:'lsp_symbols',completions:'lsp_completions',code_actions:'lsp_code_actions',overview:'code_overview',search:'ast_search'});
const positioned = new Set(['hover','definition','references','completions','code_actions']);
export function lspParameters(input, file) {
  if (!Object.hasOwn(LSP_METHODS,input.method)) throw new Error('Unsupported LSP method');
  const params={path:file};
  if (input.query !== undefined) {
    if (typeof input.query !== 'string' || !input.query.trim() || input.query.length>4000) throw new Error('query must be a nonempty symbol or pattern');
    params.query=input.query;
  }
  if (input.line!==undefined || input.character!==undefined) {
    if (!Number.isInteger(input.line)||input.line<1||!Number.isInteger(input.character)||input.character<1) throw new Error('line and character must both be positive 1-based integers');
    params.line=input.line;params.character=input.character;
  }
  if(positioned.has(input.method)&&params.line===undefined&&!params.query) throw new Error('Provide line/character or an exact symbol query');
  if(input.method==='search') {
    if(!params.query||typeof input.language!=='string'||!input.language) throw new Error('search requires query (structural pattern) and language');
    params.pattern=params.query;delete params.query;params.language=input.language;
  } else if(input.language!==undefined) throw new Error('language is only accepted for search');
  if(!positioned.has(input.method)&&params.line!==undefined) throw new Error('This method does not accept a position');
  if(['diagnostics','overview'].includes(input.method)&&params.query) throw new Error('This method does not accept query');
  return params;
}

export async function runDirectLsp(request, signal) {
  const result=await runWslSandbox(['--direct-lsp'],{...request,access:'read',input:JSON.stringify({tool:LSP_METHODS[request.method],params:request.params}),readScope:[request.file],writeScope:[],signal});
  let payload;
  try { payload=JSON.parse(result.stdout); } catch { payload={ok:false,error:'LSP runner returned invalid JSON'}; }
  const infrastructureOk=result.exitCode===0&&!result.failure&&result.cleanup?.ok===true;
  return {...payload,status:infrastructureOk?payload.status:(payload.ok===false?payload.status??'failed':'failed'),ok:infrastructureOk&&payload.ok===true,failure:result.failure,exitCode:result.exitCode,cleanup:result.cleanup,stderr:result.stderr};
}
