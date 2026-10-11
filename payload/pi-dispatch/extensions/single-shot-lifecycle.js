import {LIFECYCLE_STATE} from '../scripts/pi-single-shot-lifecycle.mjs';
export default function singleShotLifecycle(pi){
  const state=globalThis[LIFECYCLE_STATE];
  if(!state)return;
  for(const name of ['agent_start','agent_end','agent_settled','tool_execution_start','tool_execution_end','session_shutdown'])pi.on(name,event=>state.event(name,event));
}
