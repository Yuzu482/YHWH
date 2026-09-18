// Root launcher supplies FD3. Only this wrapper keeps the host RPC stdin open.
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {EDITOR_FRAME} from './editor-rpc.mjs';
let buffer='',output='',child=null,sequence=0,pending=null,ended=false;
function stop(){if(ended)return;ended=true;child?.kill('SIGTERM');process.exitCode=2;process.stdin.destroy();}
process.stdin.setEncoding('utf8');
process.stdin.on('data',chunk=>{
 buffer+=chunk;if(Buffer.byteLength(buffer)>1048576){stop();return;}
 let index;
 while((index=buffer.indexOf('\n'))>=0){
  const line=buffer.slice(0,index);buffer=buffer.slice(index+1);
  try{
   const message=JSON.parse(line);
   if(!child){
    if(Object.keys(message).join(',')!=='prompt'||typeof message.prompt!=='string'||message.prompt.length>300000)throw Error();
    child=spawn(process.execPath,[fileURLToPath(new URL('./secure-pi-bootstrap.mjs',import.meta.url)),...process.argv.slice(2)],{stdio:['pipe','pipe','pipe',3,'ipc'],env:process.env});
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',chunk=>{output+=chunk;if(Buffer.byteLength(output)>8388608){stop();return;}let at;while((at=output.indexOf('\n'))>=0){process.stdout.write(output.slice(0,at+1));output=output.slice(at+1);}});
    child.stderr.pipe(process.stderr);
    child.on('message',request=>{
     if(ended||pending||Object.keys(request||{}).sort().join(',')!=='id,operationId'||request.id!==++sequence||typeof request.operationId!=='string'||request.operationId.length>64){stop();return;}
     pending=request.id;process.stdout.write(EDITOR_FRAME+JSON.stringify(request)+'\n');
    });
    child.on('error',stop);
    child.on('close',code=>{if(output)process.stdout.write(output);ended=true;process.exitCode=code??2;process.stdin.destroy();});
    child.stdin.on('error',()=>{});child.stdin.end(message.prompt);
   }else{
    if(message.id!==pending||!pending||Object.keys(message).sort().join(',')!=='id,result')throw Error();
    pending=null;child.send(message,error=>{if(error)stop();});
   }
  }catch{stop();return;}
 }
});
process.stdin.on('end',()=>{if(!ended)stop();});
process.stdin.on('error',stop);
process.once('SIGTERM',stop);process.once('SIGINT',stop);
