// SPDX-License-Identifier: Apache-2.0
// First-party, single-source design-time project. Never imports user projects.
import {readFileSync,writeFileSync,statSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
export function csharpProject(file){
  if(typeof file!=='string'||!file.toLowerCase().endsWith('.cs')||file.startsWith('/')||/[\\:\0]/.test(file)||file.split('/').some(p=>!p||p==='.'||p==='..'))throw Error('invalid-csharp-file');
  const escaped=file.replace(/[%$@'();?*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase()).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  return `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><OutputType>Library</OutputType><EnableDefaultCompileItems>false</EnableDefaultCompileItems><EnableNETAnalyzers>false</EnableNETAnalyzers><GenerateAssemblyInfo>false</GenerateAssemblyInfo><BaseOutputPath>/tmp/yhwh-csharp/bin/</BaseOutputPath><BaseIntermediateOutputPath>/tmp/yhwh-csharp/obj/</BaseIntermediateOutputPath><NuGetAudit>false</NuGetAudit></PropertyGroup><ItemGroup><Compile Include="${escaped}" /></ItemGroup></Project>\n`;
}
export function prepareCsharpSnapshot(workspace,file){
  const project=csharpProject(file);
  if(!statSync(join(workspace,file)).isFile())throw Error('invalid-csharp-file');
  writeFileSync(join(workspace,'YHWH.csproj'),project,{flag:'wx',mode:0o444});
  writeFileSync(join(workspace,'NuGet.Config'),'<configuration><packageSources><clear /></packageSources></configuration>\n',{flag:'wx',mode:0o444});
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [workspace,scopes]=process.argv.slice(2);
  if(process.getuid?.()!==0||!/^\/var\/lib\/pi-kether\/jobs\/[a-f0-9-]{36}\/workspace$/.test(workspace))throw Error('invalid-csharp-workspace');
  const read=JSON.parse(readFileSync(scopes,'utf8')).read;
  if(!Array.isArray(read)||read.length!==1)throw Error('invalid-csharp-scope');
  prepareCsharpSnapshot(workspace,read[0]);
}
