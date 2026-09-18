// Adapter for the pinned pi-lsp-extension result contract; never treats code
// diagnostics (errors in the inspected file) as tool execution failures.
export function classifyLspResult(result, {tool, backend, diagnosticsPublished=false}={}) {
  const response=(status,reason)=>({ok:['success','no-match','degraded'].includes(status),status,reason});
  if(!result||!Array.isArray(result.content)||!result.content.length)return response('failed','invalid-tool-result');
  if(result.isError===true)return response('failed','tool-error');
  const text=result.content.filter(item=>item.type==='text').map(item=>item.text??'').join('\n').trim();
  if(!text)return response('failed','empty-tool-result');
  // The pinned search/overview adapters report exceptions as a leading Error:
  // instead of isError. Limit this compatibility rule to structural operations.
  if(['ast_search','code_overview'].includes(tool)&&/^Error:/i.test(text))return response('failed','structural-operation-error');
  if(/^LSP (?:hover|definition|references|completion|code action|document symbols|workspace symbols) request failed:/i.test(text))return response('failed','language-service-request-failed');
  if(/^(?:Either line\/character or query is required\.|Could not resolve position)/.test(text))return response('failed','invalid-position');
  if(backend==='unavailable'||/^(?:No LSP server|LSP server .* (?:starting|initializing)|No language server|No provider available)/i.test(text))return response('unavailable','language-service-unavailable');
  if(tool==='lsp_diagnostics'&&backend==='lsp'&&!diagnosticsPublished)return response('unavailable','diagnostics-not-published');
  if(backend==='tree-sitter'&&!['ast_search','code_overview'].includes(tool))return response('degraded','syntax-or-structure-only');
  if(tool!=='lsp_diagnostics'&&(result.details?.count===0||result.details?.matchCount===0))return response('no-match','no-match');
  if(result.details?.hasResult===false||/^Could not find symbol\b|^No (?:matches found|completions available|definitions? found|references? found|symbols found|code actions)/i.test(text))return response('no-match','no-match');
  if(!['lsp','tree-sitter'].includes(backend))return response('unavailable','unknown-backend');
  return response('success',null);
}
