// Trusted model-free adapter for the installed pi-lsp-extension tool factories.
import {readFileSync,realpathSync,closeSync} from 'node:fs';
import {classifyLspResult} from './lsp-result.mjs';
import {createRequire} from 'node:module';
const require=createRequire('/opt/pi-kether/node_modules/@earendil-works/pi-coding-agent/package.json');
const {createJiti}=require('jiti');
const jiti=createJiti(import.meta.url,{moduleCache:true});
const base='/opt/pi-kether/node_modules/pi-lsp-extension/src/';
const load=path=>jiti.import(base+path);
const factories={lsp_diagnostics:['diagnostics','createDiagnosticsTool'],lsp_hover:['hover','createHoverTool'],lsp_definition:['definition','createDefinitionTool'],lsp_references:['references','createReferencesTool'],lsp_symbols:['symbols','createSymbolsTool'],lsp_completions:['completions','createCompletionsTool'],lsp_code_actions:['code-actions','createCodeActionsTool'],code_overview:['code-overview','createCodeOverviewTool'],ast_search:['code-search','createCodeSearchTool']};
const pause=()=>new Promise(resolve=>setTimeout(resolve,100));
let manager,tree,response;
const startupErrors=[];
try {
  closeSync(3); // The direct branch receives an empty descriptor, never provider auth.
  const input=JSON.parse(readFileSync(0,'utf8'));
  if(!Object.hasOwn(factories,input.tool)||!input.params||typeof input.params.path!=='string')throw new Error('Invalid direct LSP request');
  const path=realpathSync(input.params.path);
  if(!path.startsWith('/workspace/'))throw new Error('LSP file outside scoped workspace');
  input.params.path=path;
  const {LspManager}=await load('lsp-manager.ts');
  const {TreeSitterManager}=await load('tree-sitter/parser-manager.ts');
  const {WorkspaceIndex}=await load('tree-sitter/workspace-index.ts');
  manager=new LspManager('/workspace',undefined,{onServerError:(_language,error)=>startupErrors.push(error)});
  tree=new TreeSitterManager();await tree.init();
  const index=new WorkspaceIndex('/workspace',tree);
  const structural=['code_overview','ast_search'].includes(input.tool);
  let client,diagnosticsPublished=false;
  if(!structural){
    client=await manager.getClientForFile(path);
    const language=manager.getLanguageId(path),deadline=Date.now()+60000;
    while(!client&&language&&manager.isServerStarting(language)&&Date.now()<deadline){await pause();client=manager.getRunningClient(language);}
    if(client){
      const uri=manager.getFileUri(path);
      client.didOpen(uri,language,1,readFileSync(path,'utf8'));
      if(input.tool==='lsp_diagnostics'){
        const deadline=Date.now()+15000;
        while(!client.getAllDiagnostics().has(uri)&&Date.now()<deadline)await pause();
        diagnosticsPublished=client.getAllDiagnostics().has(uri);
        if(!diagnosticsPublished)throw new Error('Language server has not published diagnostics; clean result is unverified');
      }
    }
  }
  const [module,name]=factories[input.tool];
  const factory=(await load('tools/'+module+'.ts'))[name];
  let args=[manager,tree,index];
  if(structural)args=['/workspace',tree,index];
  if(input.tool==='lsp_completions')args=[manager,{getTrackedVersion:()=>1,setTrackedVersion(){},isSyntheticDotActive:()=>false},tree];
  const tool=factory(...args);
  const result=await tool.execute('direct-lsp',input.params,new AbortController().signal);
  const backend=client?'lsp':structural||result.content?.some(item=>/tree-sitter/i.test(item.text??''))?'tree-sitter':'unavailable';
  response={...classifyLspResult(result,{tool:input.tool,backend,diagnosticsPublished}),requestedTool:input.tool,toolsUsed:[input.tool],unexpectedTools:[],backend,diagnosticsPublished,startupErrors,result};
}catch(error){response={ok:false,status:'failed',error:error.message,startupErrors,toolsUsed:[]};}
finally{
  try{if(manager)await manager.shutdownAll();tree?.shutdown();}
  catch(error){response={...response,ok:false,status:'failed',error:'LSP shutdown failed: '+error.message};}
}
process.stdout.write(JSON.stringify(response),()=>process.exit(response.ok?0:1));
