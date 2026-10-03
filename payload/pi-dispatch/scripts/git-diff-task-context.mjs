import {collectGitDiffContext} from './git-diff-context.mjs';
import {isReviewer} from '../extensions/review-contract.js';

const byteLength=value=>Buffer.byteLength(value,'utf8');

/** Adds fresh, bounded Git evidence to an eligible dispatch task without mutating its caller-owned object. */
export async function addGitDiffTaskContext({cwd,task,access,operation,roots,signal}={}){
 if(!task||typeof task!=='object'||!['read','workspace-write'].includes(access)||operation==='probe_model'||isReviewer(task.role))return task;
 const scope=[...(Array.isArray(task.readScope)?task.readScope:[]),...(Array.isArray(task.writeScope)?task.writeScope:[])];
 if(!scope.length)return task;
 const original=Array.isArray(task.context)?task.context:[];
 if(original.length>=64)return task;
 const used=byteLength(original.join('\n'));
 const remaining=Math.max(0,Math.min(4096,8192-used-(original.length?1:0)));
 const slots=Math.max(0,Math.min(59,64-original.length));
 if(!remaining||!slots)return task;
 const {contexts}=await collectGitDiffContext({cwd,roots,readScope:task.readScope??[],writeScope:task.writeScope??[],maxBytes:remaining,maxEntries:slots,signal});
 signal?.throwIfAborted();
 if(!contexts.length)return task;
 return {...task,context:[...original,...contexts].slice(0,64)};
}
