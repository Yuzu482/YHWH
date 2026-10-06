import {exportResult} from './result-export.js';
import { resolveRolePreset } from '../scripts/role-presets.mjs';
import { createTaskHeartbeat } from './task-heartbeat.js';
import { createHash } from 'node:crypto';
import { redactSensitiveText, summarizePatch, summarizeUsage } from './audit-log.js';

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'blocked', 'awaiting-host-verification']);

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(stable(value)), 'utf8').digest('hex');
}

function toolSummary(result) {
  const counts = {};
  for (const name of Array.isArray(result?.toolsUsed) ? result.toolsUsed : []) {
    if (/^[A-Za-z0-9_.:-]{1,128}$/.test(name)) counts[name] = (counts[name] || 0) + 1;
  }
  return { counts, total: Object.values(counts).reduce((sum, count) => sum + count, 0), errors: Number(result?.toolErrors) || 0 };
}

function publicRecord(record, now = Date.now()) {
  const result = record.result ?? record.resultSummary;
  return {
    requestId: record.requestId,
    parentRunId: record.parentRunId,
    gatewayInstanceId: record.gatewayInstanceId,
    role: record.role,
    displayName: record.displayName,
    displayNameZh: record.displayNameZh,
    state: record.state,
    requestedProvider: record.provider,
    requestedModel: record.model,
    actualProvider: result?.provider,
    actualModel: result?.model,
    access: record.access,
    resourceProfile: record.resourceProfile,
    priority: record.priority,
    dependsOnRequestIds: record.dependsOnRequestIds,
    createdAt: record.createdAt,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    waitReasons:record.state==='queued' ? [...record.waitReasons] : [],
    queueTimeoutSeconds:record.queueTimeoutSeconds,
    executionTimeoutSeconds:record.timeoutSeconds,
    queueDeadlineAt:record.queueDeadlineAt,
    queueWaitMs:result?.timings?.queueWaitMs ?? Math.max(0,Date.parse(record.startedAt??record.finishedAt??new Date(now).toISOString())-Date.parse(record.createdAt)),
    executionMs:result?.timings?.executionMs ?? (record.startedAt?Math.max(0,(record.finishedAt?Date.parse(record.finishedAt):now)-Date.parse(record.startedAt)):0),
    phaseTimings:result?.phaseTimings??record.phaseTimings??null,
    heartbeat: record.heartbeat.snapshot(),
    elapsedMs: Math.max(0, (record.finishedAt ? Date.parse(record.finishedAt) : now) - Date.parse(record.createdAt)),
    cancellable: !TERMINAL.has(record.state) && record.state !== 'cancelling',
    outcome: TERMINAL.has(record.state) ? {
      ok: result?.ok === true,
      ...(record.state==='awaiting-host-verification'?{hostVerification:result?.hostVerification??null}:{}),
      tools: record.resultSummary?.toolSummary ?? toolSummary(result),
      tokens: record.resultSummary?.tokens ?? summarizeUsage(result?.usage),
      patch: record.resultSummary?.patchSummary ?? summarizePatch(result?.patch),
      formatValid: result?.formatValidation?.ok,
      reviewDecision:result?.reviewValidation?.decision??result?.reviewDecision,
      missingMaterials:result?.reviewValidation?.missingMaterials??result?.missingMaterials,
      failureReason: record.failureReason,
    } : null,
  };
}

export function createTaskMonitor({ gatewayInstanceId, maxEntries = 512, createHeartbeat = createTaskHeartbeat, maxResultBytes = 134217728, terminalTtlMs = 3600000, maintenanceIntervalMs = 60000, persistResult, loadResult } = {}) {
  if (!gatewayInstanceId) throw new Error('gatewayInstanceId is required');
  if (!Number.isInteger(maxEntries) || maxEntries < 16 || maxEntries > 4096) throw new Error('maxEntries must be an integer from 16 to 4096');
  for (const [name,value] of Object.entries({maxResultBytes,terminalTtlMs,maintenanceIntervalMs})) if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`);
  if (persistResult !== undefined && typeof persistResult !== 'function' || loadResult !== undefined && typeof loadResult !== 'function') throw new Error('result cache callbacks must be functions');
  const records = new Map();
  const waiters = new Map();
  let waiterCount = 0;
  let closed = false;
  let resultBytes = 0;
  const encodedSize = value => Buffer.byteLength(JSON.stringify(value) ?? 'null');
  const setResult = (record, value) => { resultBytes -= record.resultBytes || 0; record.result=value; record.resultBytes=value==null?0:encodedSize(value); resultBytes += record.resultBytes; };
  function wakeWaiters(record) {
    const snapshot = { ok: true, ready: true, requestId: record.requestId, state: record.state, gatewayInstanceId };
    const pending = waiters.get(record.requestId);
    if (!pending) return;
    waiters.delete(record.requestId);
    for (const waiter of pending) waiter.finish(snapshot);
  }
  function persistTerminal(record) {
    if (typeof persistResult !== 'function' || record.persisted || record.result == null) return;
    try { record.persisted = persistResult(record.requestId,{state:record.state,result:record.result}) === true; } catch { record.persisted=false; }
  }
  function trim(now = Date.now()) {
    const terminal = [...records.values()].filter(record => TERMINAL.has(record.state)).sort((a,b)=>Date.parse(a.finishedAt||0)-Date.parse(b.finishedAt||0));
    for (const record of terminal) {
      const expired = now - Date.parse(record.finishedAt || now) >= terminalTtlMs;
      const overCount = records.size > maxEntries;
      if (!expired && !(resultBytes > maxResultBytes && record.result != null) && !(overCount && records.has(record.requestId))) continue;
      if (!record.persisted && typeof persistResult === 'function') {
        try { record.persisted = persistResult(record.requestId,{state:record.state,result:record.result}) === true; } catch { record.persisted=false; }
      }
      if (!record.persisted && record.result != null) continue;
      if (record.result != null) setResult(record,null);
      if (expired || overCount) records.delete(record.requestId);
    }
  }
  const maintenanceTimer = maintenanceIntervalMs ? setInterval(()=>trim(),maintenanceIntervalMs) : null;
  maintenanceTimer?.unref?.();

  function submit(input, runner) {
    const requestId = input.requestId;
    if (!requestId) throw new Error('monitored submissions require a stable requestId');
    const inputDigest = digest(input);
    const existing = records.get(requestId);
    if (existing) {
      if (existing.inputDigest !== inputDigest) throw new Error('requestId is already assigned to a different monitored task');
      return { accepted: false, replayed: true, task: publicRecord(existing) };
    }

    const controller = new AbortController();
    const heartbeat = createHeartbeat();
    const now = new Date().toISOString();
    const canonicalRole = (() => { try { return resolveRolePreset(input.task?.role || '').id; } catch { return null; } })();
    const rolePreset = canonicalRole ? resolveRolePreset(canonicalRole) : null;
    const record = {
      requestId,
      parentRunId: input.parentRunId,
      gatewayInstanceId,
      role: /^[A-Za-z][A-Za-z0-9._ -]{0,63}$/.test(input.task?.role || '') ? input.task.role : 'unknown',
      displayName: rolePreset?.displayName,
      displayNameZh: rolePreset?.displayNameZh,
      provider: input.provider,
      model: input.model,
      access: input.access,
      resourceProfile: input.resourceProfile,
      priority: input.priority,
      dependsOnRequestIds: [...(input.dependsOnRequestIds || [])],
      waitReasons:[],queueDeadlineAt:null,queueTimeoutSeconds:input.queueTimeoutSeconds??120,timeoutSeconds:input.timeoutSeconds,
      inputDigest,
      state: 'queued',
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      failureReason: null,
      result: null,
      resultBytes:0, persisted:false,
      phaseTimings:null,
      controller,
      heartbeat,
    };
    records.set(requestId, record);
    trim();

    const markRunning = info => {
      if (record.state === 'queued') {
        record.state = 'running';
        record.startedAt = new Date().toISOString();
        if(info?.executionTimeoutSeconds) record.timeoutSeconds=info.executionTimeoutSeconds;
        record.waitReasons=[];
        record.heartbeat.start();
      }
    };
    record.promise = Promise.resolve().then(() => {
      if (controller.signal.aborted) throw new Error('cancelled before execution');
      return runner(controller.signal, markRunning, value=>{
        if(record.state==='queued') {record.waitReasons=[...value.waitReasons];record.queueDeadlineAt=value.queueDeadlineAt;record.timeoutSeconds=value.executionTimeoutMs/1000;}
      },value=>{record.heartbeat.progress();record.phaseTimings=value;});
    }).then(envelope => {
      const result = envelope?.response ?? envelope;
      record.finishedAt = new Date().toISOString();
      record.heartbeat.stop();
      if (record.state === 'cancelling' || controller.signal.aborted) {
        record.state = 'cancelled';
        record.failureReason = 'cancelled by Tifereth';
      } else if (result?.status === 'awaiting-host-verification') {
        record.state = 'awaiting-host-verification';
        record.failureReason = null;
      } else if (result?.status==='blocked' || result?.reviewValidation?.decision==='insufficient-materials') {
        record.state='blocked';record.failureReason=redactSensitiveText(result.error??result.failure);
      } else if (result?.ok === true && envelope?.isError !== true) {
        record.state = 'completed';
      } else {
        record.state = 'failed';
        record.failureReason = redactSensitiveText(result?.error ?? result?.failure ?? 'execution failed');
      }
      record.resultSummary = result && typeof result === 'object' ? {provider:result.provider,model:result.model,timings:result.timings,phaseTimings:result.phaseTimings,ok:result.ok,status:result.status,hostVerification:result.hostVerification,formatValidation:result.formatValidation,reviewValidation:result.reviewValidation,reviewDecision:result.reviewDecision,missingMaterials:result.missingMaterials,toolSummary:toolSummary(result),tokens:summarizeUsage(result.usage),patchSummary:summarizePatch(result.patch)} : result;
      setResult(record,result); persistTerminal(record);
      wakeWaiters(record);
      trim();
      record.promise=null; record.controller=null;
      return undefined;
    }).catch(error => {
      record.finishedAt = new Date().toISOString();
      record.heartbeat.stop();
      record.state = record.state === 'cancelling' || controller.signal.aborted ? 'cancelled' : 'failed';
      record.failureReason = redactSensitiveText(record.state === 'cancelled' ? 'cancelled by Tifereth' : error?.message ?? 'execution failed');
      const result={ok:false,requestId,error:record.failureReason,...(error?.code==='EXECUTION_TIMEOUT'?{failureCode:'EXECUTION_TIMEOUT'}:{}),phaseTimings:record.phaseTimings};
      record.resultSummary={ok:false,error:record.failureReason,...(error?.code==='EXECUTION_TIMEOUT'?{failureCode:'EXECUTION_TIMEOUT'}:{}),phaseTimings:record.phaseTimings}; setResult(record,result); persistTerminal(record); wakeWaiters(record); trim();
      record.promise=null; record.controller=null;
      return undefined;
    });

    return { accepted: true, replayed: false, task: publicRecord(record) };
  }

  function get(requestId) {
    const record = records.get(requestId);
    return record ? publicRecord(record.result==null&&record.resultSummary?{...record,result:record.resultSummary}:record) : null;
  }

  function getResult(requestId,page={}) {
    const record=records.get(requestId);
    if(!record) {
      if(typeof loadResult==='function') {
        try {
          const stored=loadResult(requestId);
          if(stored?.state==='indeterminate') return {ok:false,ready:false,code:'RESULT_INDETERMINATE',requestId,gatewayInstanceId};
          if(stored && TERMINAL.has(stored.state) && stored.result!=null) return {ok:true,ready:true,requestId,state:stored.state,gatewayInstanceId,...exportResult(stored.result,page)};
        } catch {}
      }
      return {ok:false,ready:false,code:'RESULT_NOT_FOUND',requestId,gatewayInstanceId};
    }
    if(!TERMINAL.has(record.state))return {ok:true,ready:false,requestId,state:record.state};
    let result=record.result;
    if(typeof loadResult==='function') {
      try {
        const stored=loadResult(requestId);
        if(stored?.state==='indeterminate') return {ok:false,ready:false,code:'RESULT_INDETERMINATE',requestId,gatewayInstanceId};
        if(stored && TERMINAL.has(stored.state)) {
          if(stored.state!==record.state) return {ok:false,ready:false,code:'RESULT_INDETERMINATE',requestId,gatewayInstanceId};
          if(stored.result!=null) result=stored.result;
        }
      } catch {}
    }
    if(result==null) return {ok:false,ready:false,code:'RESULT_NOT_FOUND',requestId,gatewayInstanceId};
    return {ok:true,ready:true,requestId,state:record.state,gatewayInstanceId,...exportResult(result,page)};
  }

  function wait(requestId, { timeoutMs = 55000, signal } = {}) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 55000) throw new Error('timeoutMs must be an integer from 0 to 55000');
    const envelope = value => ({ ...value, requestId, gatewayInstanceId });
    if (closed) return Promise.resolve(envelope({ok:false,ready:false,code:'MONITOR_CLOSED'}));
    let record = records.get(requestId);
    if (record && TERMINAL.has(record.state)) return Promise.resolve(envelope({ok:true,ready:true,state:record.state}));
    if (!record && typeof loadResult === 'function') {
      try {
        const stored=loadResult(requestId);
        if(stored?.state==='indeterminate') return Promise.resolve(envelope({ok:false,ready:false,code:'RESULT_INDETERMINATE'}));
        if(stored && TERMINAL.has(stored.state)) return Promise.resolve(envelope({ok:true,ready:true,state:stored.state}));
      } catch {}
    }
    if (!record) return Promise.resolve(envelope({ok:false,ready:false,code:'RESULT_NOT_FOUND'}));
    if (timeoutMs === 0) return Promise.resolve(envelope({ok:true,ready:false,state:record?.state}));
    if (waiterCount >= 128) return Promise.resolve(envelope({ok:false,ready:false,code:'WAIT_LIMIT'}));
    if (signal?.aborted) return Promise.resolve(envelope({ok:false,ready:false,code:'WAIT_ABORTED'}));
    return new Promise(resolve => {
      let settled = false;
      const finish = value => { if (settled) return; settled=true; clearTimeout(timer); signal?.removeEventListener('abort',abort); const list=waiters.get(requestId); if(list){list.delete(waiter);if(!list.size)waiters.delete(requestId);} waiterCount--; resolve(value); };
      const abort = () => finish(envelope({ok:false,ready:false,code:'WAIT_ABORTED'}));
      const timer=setTimeout(()=>finish(envelope({ok:true,ready:false,state:records.get(requestId)?.state})),timeoutMs);
      const waiter={finish};
      if(!waiters.has(requestId))waiters.set(requestId,new Set());
      waiters.get(requestId).add(waiter); waiterCount++;
      signal?.addEventListener('abort',abort,{once:true});
      const latest=records.get(requestId);
      if(latest && TERMINAL.has(latest.state)) wakeWaiters(latest);
    });
  }

  function resolveHostVerification(requestId, result) {
    const record=records.get(requestId);
    if (!record || record.state!=='awaiting-host-verification' || !result || !['completed','failed'].includes(result.state)) return false;
    record.state=result.state;
    record.persisted=false;
    record.finishedAt=new Date().toISOString();
    record.failureReason=result.state==='failed' ? redactSensitiveText(result.failure??'host verification failed') : null;
    record.heartbeat.stop();
    record.resultSummary=result && typeof result==='object'?{provider:result.provider,model:result.model,timings:result.timings,phaseTimings:result.phaseTimings,ok:result.ok,status:result.status,hostVerification:result.hostVerification,formatValidation:result.formatValidation,reviewValidation:result.reviewValidation,reviewDecision:result.reviewDecision,missingMaterials:result.missingMaterials,toolSummary:toolSummary(result),tokens:summarizeUsage(result.usage),patchSummary:summarizePatch(result.patch)}:result; setResult(record,result); persistTerminal(record); wakeWaiters(record); trim();
    return true;
  }

  function list({ parentRunId, limit = 50 } = {}) {
    return [...records.values()]
      .filter(record => !parentRunId || record.parentRunId === parentRunId)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, limit)
      .map(record => publicRecord(record));
  }

  function cancel(requestId) {
    const record = records.get(requestId);
    if (!record) return { accepted: false, reason: 'not_found', task: null };
    if (TERMINAL.has(record.state)) return { accepted: false, reason: 'already_terminal', task: publicRecord(record) };
    if (record.state !== 'cancelling') {
      record.heartbeat.stop();
      record.state = 'cancelling';
      record.controller.abort();
    }
    return { accepted: true, reason: 'cancellation_requested', task: publicRecord(record) };
  }

  function close() {
    if (closed) return;
    closed=true;
    for (const [requestId, pending] of waiters) for (const waiter of [...pending]) waiter.finish({ok:false,ready:false,requestId,code:'MONITOR_CLOSED'});
    if(maintenanceTimer) clearInterval(maintenanceTimer);
    for (const record of records.values()) {
      if (!TERMINAL.has(record.state) || record.result==null) continue;
      persistTerminal(record);
      if (record.persisted) setResult(record,null);
    }
  }
  return { submit, get, getResult, wait, resolveHostVerification, list, cancel, close, get size() { return records.size; } };
}
