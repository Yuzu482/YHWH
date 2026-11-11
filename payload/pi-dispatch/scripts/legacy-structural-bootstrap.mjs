// SPDX-License-Identifier: Apache-2.0
// Explicit structural-only compatibility backend; never a fallback for semantic LSP.
import {realpathSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {classifyLspResult} from './lsp-result.mjs';
export async function runStructural(input) {
  const factories={code_overview:['code-overview','createCodeOverviewTool'],ast_search:['code-search','createCodeSearchTool']};
  let tree,response;
  try {
    if(!Object.hasOwn(factories,input.tool)||typeof input.params?.path!=='string')throw new Error('Invalid structural request');
    const path=realpathSync(input.params.path);
    if(!path.startsWith('/workspace/'))throw new Error('File outside workspace');
    const module=await import(pathToFileURL('/opt/pi-kether/node_modules/pi-lsp-extension/dist/index.js').href);
    const {TreeSitterManager,WorkspaceIndex}=module;
    tree=new TreeSitterManager();await tree.init();
    const index=new WorkspaceIndex('/workspace',tree);
    const [,name]=factories[input.tool];
    const factory=module[name];
    const tool=factory('/workspace',tree,index);
    const result=await tool.execute('direct-lsp',{...input.params,path},new AbortController().signal);
    response={...classifyLspResult(result,{tool:input.tool,backend:'tree-sitter'}),result};
  }catch {response={ok:false,status:'failed',reason:'structural-backend-error'};}
  finally {try {tree?.shutdown();}catch {response={ok:false,status:'failed',reason:'structural-cleanup-failed'};}}
  return {...response,requestedTool:input.tool,toolsUsed:[input.tool],unexpectedTools:[],
    engine:'pi-lsp-extension',engineVersion:'1.4.0',backend:'tree-sitter',diagnosticsPublished:false,modelCalls:0};
}
