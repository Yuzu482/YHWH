import {createModuleLifecycle} from '../extensions/module-lifecycle.js';

// This is a task control field carried in the existing bounded context array.
// It selects only trusted, preinstalled optional helpers; it cannot supply code,
// change a role, widen file access, or disable any security/ledger service.
export const TASK_COMPONENTS_PREFIX='TASK_COMPONENTS_JSON=';
export const TASK_COMPONENTS=Object.freeze(['gitContext','projectMemory']);

function invalid() {
  return Object.assign(new Error('Invalid task component selection'),{code:'PI_TASK_COMPONENTS_INVALID',modelExecutionStarted:false});
}

export function selectTaskComponents(task) {
  const context=Array.isArray(task?.context)?task.context:[];
  const controls=context.filter(value=>typeof value==='string'&&value.startsWith(TASK_COMPONENTS_PREFIX));
  if(controls.length>1) throw invalid();
  if(!controls.length) return {task,selected:[],explicit:false};
  let selection;
  try { selection=JSON.parse(controls[0].slice(TASK_COMPONENTS_PREFIX.length)); }
  catch { throw invalid(); }
  if(!selection||typeof selection!=='object'||Array.isArray(selection)||
     Object.keys(selection).sort().join(',')!=='components,version'||selection.version!==1||
     !Array.isArray(selection.components)||selection.components.length>TASK_COMPONENTS.length||
     selection.components.some(id=>typeof id!=='string'||!TASK_COMPONENTS.includes(id))||
     new Set(selection.components).size!==selection.components.length) throw invalid();
  const selected=TASK_COMPONENTS.filter(id=>selection.components.includes(id));
  return {task:{...task,context:context.filter(value=>value!==controls[0])},selected,explicit:true};
}

// Each invocation owns its selected instances and waits for reverse-order
// disposal. No registry, audit service, authorization, or ledger is replaced.
export async function withTaskComponents(selected,definitions,run) {
  if(!Array.isArray(selected)||!Array.isArray(definitions)||typeof run!=='function') throw invalid();
  const byId=new Map(definitions.map(definition=>[definition.id,definition]));
  if(byId.size!==definitions.length||new Set(selected).size!==selected.length||
     selected.some(id=>!TASK_COMPONENTS.includes(id)||!byId.has(id))) throw invalid();
  let scope;
  try { scope=createModuleLifecycle(selected.map(id=>byId.get(id))); }
  catch(error) {
    try { await error.cleanup; } catch(cleanup) { throw new AggregateError([error,cleanup],'Task component initialization and cleanup failed'); }
    throw error;
  }
  let value, failure;
  try { value=await run(scope); } catch(error) { failure=error; }
  try { await scope.dispose(); }
  catch(cleanup) {
    if(failure) throw new AggregateError([failure,cleanup],'Task component execution and cleanup failed');
    throw cleanup;
  }
  if(failure) throw failure;
  return value;
}
