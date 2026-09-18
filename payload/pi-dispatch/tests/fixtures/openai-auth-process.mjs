import {maintainOpenAIAuth} from '../../scripts/openai-auth-store.mjs';
import {appendFileSync} from 'node:fs';
import {join} from 'node:path';
const root=process.argv[2];
try {
  const result=await maintainOpenAIAuth({authPath:join(root,'auth.json'),stateDir:join(root,'state'),minimumValidityMs:360000,withAuthLock:async work=>work(),refresh:async credential=>{
    appendFileSync(join(root,'refresh-calls.txt'),'refresh\n');
    if(process.argv[3]==='--crash-after-rotation')process.exit(9);
    await new Promise(resolve=>setTimeout(resolve,150));
    return {...credential,access:'fixture-access-rotated',refresh:'fixture-refresh-rotated',expires:Date.now()+86400000};
  }});
  process.stdout.write(JSON.stringify(result));
}catch(error){process.stdout.write(JSON.stringify({ok:false,code:error.code}));process.exitCode=1;}
