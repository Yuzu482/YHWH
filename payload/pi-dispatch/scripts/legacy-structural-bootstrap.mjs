// SPDX-License-Identifier: Apache-2.0
// Explicit structural-only compatibility backend; never a fallback for semantic LSP.
import {realpathSync} from 'node:fs';
import {createRequire} from 'node:module';
import {classifyLspResult} from './lsp-result.mjs';
export async function runStructural(input) {
  const factories={code_overview:['code-overview','createCodeOverviewTool'],ast_search:['code-search','createCodeSearchTool']};
  let tree,response;
  try {
    if(!Object.hasOwn(factories,input.tool)||typeof input.params?.path!=='string')throw new Error('Invalid structural request');
    const path=realpathSync(input.params.path);
    if(!path.startsWith('/workspace/'))throw new Error('File outside workspace');
    const require=createRequire('/opt/pi-kether/node_modules/@earendil-works/pi-coding-agent/package.json');
    const {createJiti}=require('jiti');
    const jiti=createJiti(import.meta.url,{moduleCache:true});
    const load=file=>jiti.import('/opt/pi-kether/node_modules/pi-lsp-extension/src/'+file);
    const {TreeSitterManager}=await load('tree-sitter/parser-manager.ts');
    const {WorkspaceIndex}=await load('tree-sitter/workspace-index.ts');
    tree=new TreeSitterManager();await tree.init();
    const index=new WorkspaceIndex('/workspace',tree);
    const [module,name]=factories[input.tool];
    const factory=(await load('tools/'+module+'.ts'))[name];
    const tool=factory('/workspace',tree,index);
    const result=await tool.execute('direct-lsp',{...input.params,path},new AbortController().signal);
    response={...classifyLspResult(result,{tool:input.tool,backend:'tree-sitter'}),result};
  }catch {response={ok:false,status:'failed',reason:'structural-backend-error'};}
  finally {try {tree?.shutdown();}catch {response={ok:false,status:'failed',reason:'structural-cleanup-failed'};}}
  return {...response,requestedTool:input.tool,toolsUsed:[input.tool],unexpectedTools:[],
    engine:'pi-lsp-extension',engineVersion:'1.3.0',backend:'tree-sitter',diagnosticsPublished:false,modelCalls:0};
}
