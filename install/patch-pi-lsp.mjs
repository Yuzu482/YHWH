// SPDX-License-Identifier: Apache-2.0
// Patches only the exact npm pi-lsp-extension 1.4.0 distribution. Its upstream
// MIT notice is preserved separately in licenses/ and the installed package.
import {createHash} from 'node:crypto';
import {lstatSync, readFileSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';

const args=process.argv.slice(2), root=args[0] && resolve(args[0]);
if(!root || args.length>2 || (args.length===2 && args[1]!=='--security-only')) throw Error('Usage: node patch-pi-lsp.mjs <pi-lsp-extension-root> [--security-only]');
const securityOnly=args[1]==='--security-only';
const ordinary=(p,directory=false,optional=false)=>{let s;try{s=lstatSync(p);}catch(error){if(optional&&error?.code==='ENOENT')return;throw error;}if(s.isSymbolicLink() || (directory?!s.isDirectory():!s.isFile() || s.nlink!==1))throw Error('Unsupported linked or non-regular LSP installation');};
ordinary(root,true);ordinary(join(root,'dist'),true);ordinary(join(root,'package.json'));
const metadata=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));
if(metadata.name!=='pi-lsp-extension' || metadata.version!=='1.4.0')throw Error('Only the verified pi-lsp-extension 1.4.0 package is supported');
const indexPath=join(root,'dist/index.js'), daemonPath=join(root,'dist/lsp-daemon.js');ordinary(indexPath);ordinary(daemonPath);
const noticePath=join(root,'YHWH-PATCH-NOTICE.txt');ordinary(noticePath,false,true);
const index=readFileSync(indexPath,'utf8'),daemon=readFileSync(daemonPath,'utf8');
const sha=s=>createHash('sha256').update(s).digest('hex');
const PIN=Object.freeze({
  indexOriginal:'8871bbc7d02abf6d6a62074b815206fa02b8ff6e884dfd7f56cb4e2ddada1db4',
  indexSecurity:'39e0e627ce6d4002fbef8aa3e28a3ee7009416c00d87d63065bccad3ac3cf970',
  indexFull:'89d3babc6efc08d6c15e1dca97f8d9e65b60d1a596eb7f3b7644ad36b3b978a4',
  daemonOriginal:'e2b69869d793f7dcdb689cc9be9d27f6b34e3db2d46b4898bae2e54cd87e1300',
  daemonFull:'03f81c471fd836965e03062e3707cf3dead4e01e740a9b10e9e384c7d0105201',
});
const beforeIndex=sha(index), beforeDaemon=sha(daemon);
const mode=beforeIndex===PIN.indexOriginal && beforeDaemon===PIN.daemonOriginal?'original':
  beforeIndex===PIN.indexSecurity && beforeDaemon===PIN.daemonOriginal?'security':
  beforeIndex===PIN.indexFull && beforeDaemon===PIN.daemonFull?'full':null;
if(!mode)throw Error('Unsupported or partially patched pi-lsp-extension 1.4.0 bytes');
const replaceExactly=(text,before,after)=>{if(text.split(before).length!==2)throw Error('Unsupported pi-lsp-extension patch layout');return text.replace(before,after);};
let nextIndex=index,nextDaemon=daemon;
if(mode==='original'){
  nextIndex=replaceExactly(nextIndex,'} from "vscode-languageserver-protocol/node";','} from "vscode-languageserver-protocol/node.js";');
  nextIndex=replaceExactly(nextIndex,'    projectConfig = loadProjectConfig(ctx.cwd);','    projectConfig = null; // YHWH: project executable configuration disabled');
  nextIndex=replaceExactly(nextIndex,'  findLombokJar() {\n','  findLombokJar() {\n    return null; // YHWH: project Java agents disabled\n');
  nextIndex=replaceExactly(nextIndex,'export {\n  lspExtension as default\n};','export {\n  lspExtension as default, TreeSitterManager, WorkspaceIndex,\n  createCodeOverviewTool, createCodeSearchTool\n};');
}
if(!securityOnly && mode!=='full'){
  nextIndex=replaceExactly(nextIndex,'      cwd: this.rootDir\n    });','      cwd: this.rootDir,\n      windowsHide: process.platform === "win32"\n    });');
  nextIndex=replaceExactly(nextIndex,'  java: { command: "jdtls", args: [] }\n};','  java: { command: "jdtls", args: [] },\n  c: { command: "clangd", args: [] },\n  cpp: { command: "clangd", args: [] },\n  csharp: { command: "csharp-ls", args: [] }\n};');
  nextIndex=replaceExactly(nextIndex,'        stdio: "ignore"\n      }\n    );','        stdio: "ignore",\n        windowsHide: process.platform === "win32"\n      }\n    );');
  nextDaemon=replaceExactly(nextDaemon,'    env: process.env\n  });','    env: process.env,\n    windowsHide: process.platform === "win32"\n  });');
}
const finalMode=securityOnly && mode!=='full'?'security':'full';
if(sha(nextIndex)!==PIN[finalMode==='full'?'indexFull':'indexSecurity'] || sha(nextDaemon)!==PIN[finalMode==='full'?'daemonFull':'daemonOriginal'])throw Error('Patched LSP bytes do not match the verified target');
// Every input and target is validated before either file changes. An interrupted
// two-file write is detected as a mixed state and is never silently accepted.
if(nextIndex!==index)writeFileSync(indexPath,nextIndex,'utf8');
if(nextDaemon!==daemon)writeFileSync(daemonPath,nextDaemon,'utf8');
if(sha(readFileSync(indexPath,'utf8'))!==sha(nextIndex) || sha(readFileSync(daemonPath,'utf8'))!==sha(nextDaemon))throw Error('LSP patch write verification failed');
writeFileSync(noticePath,`Modified locally by YHWH contributors. Patch mode: ${finalMode}.\nUpstream: pi-lsp-extension 1.4.0, https://github.com/samfoy/pi-lsp-extension\nOriginal gitHead: ca0b3b8e53da5b814bf851bca0be47e7b413b122\nThe original MIT license and copyright notice are retained in LICENSE.\nChanges: fix the ESM protocol import, expose read-only structural factories,\ndisable project executable configuration and Lombok discovery; full mode also\nadds hidden Windows subprocesses and C/C++/C# server entries.\nThis notice does not relicense upstream code.\n`,'utf8');
