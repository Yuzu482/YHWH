import {spawn} from 'node:child_process';
import {readFile,unlink} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {homedir,tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
const windowScript=fileURLToPath(new URL('./window.ps1',import.meta.url));
export function launchSpec({configPath=process.env.PI_GATEWAY_CONFIG||join(homedir(),'.local','state','pi-kether','gateway-silent.json'),readyFile,nodePath=process.execPath,mode='panel'}={}){
  if(!['panel','pet'].includes(mode))throw new Error('Invalid monitor mode');
  // The short hidden bootstrap creates the GUI with its own hidden console.
  // DETACHED_PROCESS makes Windows PowerShell exit before executing this script.
  return {command:join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),args:['-NoLogo','-NoProfile','-NonInteractive','-STA','-File',windowScript,'-NodePath',nodePath,'-GatewayConfig',resolve(configPath),'-ReadyFile',readyFile,'-Mode',mode,'-Background'],options:{windowsHide:true,shell:false,detached:false,stdio:'ignore'}};
}
export async function openMonitor(options={}){
  if(process.platform!=='win32')throw new Error('Desktop monitor requires the Windows host');
  const readyFile=join(tmpdir(),`pi-monitor-${randomUUID()}.json`);
  const spec=launchSpec({...options,readyFile});
  if(!existsSync(spec.args[spec.args.indexOf('-GatewayConfig')+1]))throw new Error('Gateway configuration is missing');
  let launchError=null;
  const child=spawn(spec.command,spec.args,spec.options);child.on('error',error=>{launchError=error;});child.unref();
  try{
    for(let i=0;i<80;i++){
      if(launchError)throw new Error('Monitor process could not start');
      try{const ready=JSON.parse(await readFile(readyFile,'utf8'));if(!['open','already-open'].includes(ready.state))throw new Error('Monitor initialization failed');return ready;}
      catch(error){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;}
      await new Promise(r=>setTimeout(r,250));
    }
    throw new Error('Monitor readiness was not confirmed; no task was stopped');
  }finally{await unlink(readyFile).catch(()=>{});}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  openMonitor({mode:process.argv.includes('--pet')?'pet':'panel'}).then(result=>console.log(JSON.stringify(result))).catch(()=>{console.error('Desktop monitor could not be confirmed ready.');process.exitCode=1;});
}
