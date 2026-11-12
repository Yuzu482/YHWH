import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {inspectRepository,resolveRepository,repositoryKey,changesSince} from './lsp-change-detector.mjs';

const maxRecord=32*1024*1024;
function permitIdentity(input,nonce){
 if(!/^[a-f0-9]{64}$/.test(nonce??'')||typeof input.requestId!=='string'||!input.requestId||typeof input.cwd!=='string'||typeof input.file!=='string'||typeof input.method!=='string')throw Error('invalid_one_time_confirmation');
 const v=[nonce,input.requestId,input.cwd,input.file,input.method,input.query??null,input.line??null,input.character??null,input.language??null];
 return createHash('sha256').update(JSON.stringify(v)).digest('hex');
}
function checkedDirectory(dir,{create=false}={}){
 if(!path.isAbsolute(dir))throw Error('invalid_approval_directory');
 if(create)fs.mkdirSync(dir,{recursive:true,mode:0o700});
 if(!fs.existsSync(dir))return false;
 const st=fs.lstatSync(dir);if(!st.isDirectory()||st.isSymbolicLink())throw Error('unsafe_approval_directory');
 return true;
}
function readBaseline(dir,key){
 if(!checkedDirectory(dir))return null;const file=path.join(dir,key+'.json');
 if(!fs.existsSync(file))return null;const st=fs.lstatSync(file);
 if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>maxRecord)throw Error('unsafe_approval_record');
 try{const record=JSON.parse(fs.readFileSync(file,'utf8'));if(record.schema!==1||!record.snapshot||record.snapshot.repoHash!==key)throw Error('invalid');return record.snapshot}catch{throw Error('invalid_approval_record')}
}
function snapshotFor({cwd,file,roots,stateDir}){
 const repo=resolveRepository(cwd,roots,file),key=repositoryKey(repo),before=readBaseline(stateDir,key);
 const snapshot=inspectRepository(cwd,roots,before,file);
 if(snapshot.data.repoHash!==key)throw Error('repository_identity_changed');
 return {repo,key,before,snapshot};
}
function assessSnapshot(result,stateDir){
 if(!result.before)return {allowed:false,reason:'first',changedFiles:null,changedLines:null};
 const changes=changesSince(result.before,result.snapshot.data,{fileLimit:50,lineLimit:2000,tempDir:stateDir});
 return {allowed:!changes.major,...changes};
}
export function assessLsp(input){
 const data=snapshotFor(input),decision=assessSnapshot(data,input.stateDir);
 return {...decision,repo:data.repo,repoHash:data.key,digest:data.snapshot.digest};
}
export function acceptLsp(input,challenge){
 if(!challenge||!/^[a-f0-9]{64}$/.test(challenge.repoHash??'')||!/^[a-f0-9]{64}$/.test(challenge.digest??''))throw Error('invalid_confirmation_challenge');
 checkedDirectory(input.stateDir,{create:true});const lockPath=path.join(input.stateDir,challenge.repoHash+'.lock');let fd;
 try{
   fd=fs.openSync(lockPath,'wx',0o600);
   const data=snapshotFor(input);if(data.key!==challenge.repoHash||data.snapshot.digest!==challenge.digest)throw Error('repository_changed_during_confirmation');
   const record=Buffer.from(JSON.stringify({schema:1,acceptedAt:new Date().toISOString(),snapshot:data.snapshot.data})+'\n');
   if(record.length>maxRecord)throw Error('approval_record_too_large');
   const final=path.join(input.stateDir,data.key+'.json'),tmp=path.join(input.stateDir,data.key+'.'+randomUUID()+'.tmp');
   if(fs.existsSync(final)){const s=fs.lstatSync(final);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1)throw Error('unsafe_approval_record')}
   let w;try{w=fs.openSync(tmp,'wx',0o600);fs.writeFileSync(w,record);fs.fsyncSync(w);fs.closeSync(w);w=undefined;fs.renameSync(tmp,final)}finally{if(w!==undefined)fs.closeSync(w);if(fs.existsSync(tmp))fs.unlinkSync(tmp)}
   return {ok:true,repoHash:data.key,digest:data.snapshot.digest};
 } finally {
   if(fd!==undefined){const a=fs.fstatSync(fd),b=fs.lstatSync(lockPath);if(a.dev!==b.dev||a.ino!==b.ino)throw Error('approval_lock_changed');fs.closeSync(fd);fs.unlinkSync(lockPath)}
 }
}
export function issueOneTimeLsp(input,challenge){
 const now=Date.now();if(!challenge||!Number.isSafeInteger(challenge.expiresAt)||challenge.expiresAt<=now||challenge.expiresAt>now+300000)throw Error('invalid_one_time_confirmation');
 const key=permitIdentity(input,challenge.nonce);checkedDirectory(input.stateDir,{create:true});
 const file=path.join(input.stateDir,'once-'+key+'.json');
 fs.writeFileSync(file,JSON.stringify({schema:1,key,expiresAt:challenge.expiresAt})+'\n',{flag:'wx',mode:0o600});return {ok:true};
}
export function consumeOneTimeLsp(input,nonce){
 const key=permitIdentity(input,nonce);if(!checkedDirectory(input.stateDir))return {ok:false};
 const file=path.join(input.stateDir,'once-'+key+'.json'),claimed=path.join(input.stateDir,'used-'+randomUUID()+'.json');
 try{const st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>4096)throw Error('unsafe_one_time_confirmation');fs.renameSync(file,claimed)}catch(error){if(error.code==='ENOENT')return {ok:false};throw error}
 try{const v=JSON.parse(fs.readFileSync(claimed,'utf8'));return {ok:v.schema===1&&v.key===key&&Number.isSafeInteger(v.expiresAt)&&v.expiresAt>=Date.now()&&v.expiresAt<=Date.now()+300000}}finally{fs.unlinkSync(claimed)}
}
