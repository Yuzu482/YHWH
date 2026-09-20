import {exportResult} from './result-export.js';
import { createTaskHeartbeat } from './task-heartbeat.js';
import { createHash } from 'node:crypto';
import { redactSensitiveText, summarizePatch, summarizeUsage } from './audit-log.js';

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'blocked']);

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
  const result = record.result;
  return {
    requestId: record.requestId,
    parentRunId: record.parentRunId,
    gatewayInstanceId: record.gatewayInstanceId,
    role: record.role,
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
      tools: toolSummary(result),
      tokens: summarizeUsage(result?.usage),
      patch: summarizePatch(result?.patch),
      formatValid: result?.formatValidation?.ok,
      reviewDecision:result?.reviewValidation?.decision??result?.reviewDecision,
      missingMaterials:result?.reviewValidation?.missingMaterials??result?.missingMaterials,
      failureReason: record.failureReason,
    } : null,
  };
}

export function createTaskMonitor({ gatewayInstanceId, maxEntries = 512, createHeartbeat = createTaskHeartbeat } = {}) {
  if (!gatewayInstanceId) throw new Error('gatewayInstanceId is required');
  if (!Number.isInteger(maxEntries) || maxEntries < 16 || maxEntries > 4096) throw new Error('maxEntries must be an integer from 16 to 4096');
  const records = new Map();

  function trim() {
    if (records.size <= maxEntries) return;
    const terminal = [...records.values()].filter(record => TERMINAL.has(record.state)).sort((a, b) => Date.parse(a.finishedAt) - Date.parse(b.finishedAt));
    for (const record of terminal) {
      if (records.size <= maxEntries) break;
      records.delete(record.requestId);
    }
  }

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
    const record = {
      requestId,
      parentRunId: input.parentRunId,
      gatewayInstanceId,
      role: /^[A-Za-z][A-Za-z0-9._ -]{0,63}$/.test(input.task?.role || '') ? input.task.role : 'unknown',
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
      record.result = envelope?.response ?? envelope;
      record.finishedAt = new Date().toISOString();
      record.heartbeat.stop();
      if (record.state === 'cancelling' || controller.signal.aborted) {
        record.state = 'cancelled';
        record.failureReason = 'cancelled by Tifereth';
      } else if (record.result?.status==='blocked' || record.result?.reviewValidation?.decision==='insufficient-materials') {
        record.state='blocked';record.failureReason=redactSensitiveText(record.result.error??record.result.failure);
      } else if (record.result?.ok === true && envelope?.isError !== true) {
        record.state = 'completed';
      } else {
        record.state = 'failed';
        record.failureReason = redactSensitiveText(record.result?.error ?? record.result?.failure ?? 'execution failed');
      }
      trim();
      return envelope;
    }).catch(error => {
      record.finishedAt = new Date().toISOString();
      record.heartbeat.stop();
      record.state = record.state === 'cancelling' || controller.signal.aborted ? 'cancelled' : 'failed';
      record.failureReason = redactSensitiveText(record.state === 'cancelled' ? 'cancelled by Tifereth' : error?.message ?? 'execution failed');
      trim();
      record.result={ok:false,requestId,error:record.failureReason,phaseTimings:record.phaseTimings};
      return { response: record.result, isError: true };
    });

    return { accepted: true, replayed: false, task: publicRecord(record) };
  }

  function get(requestId) {
    const record = records.get(requestId);
    return record ? publicRecord(record) : null;
  }

  function getResult(requestId,page={}) {
    const record=records.get(requestId);
    if(!record)return {ok:false,ready:false,code:'RESULT_NOT_FOUND',requestId,gatewayInstanceId};
    if(!TERMINAL.has(record.state))return {ok:true,ready:false,requestId,state:record.state};
    return {ok:true,ready:true,requestId,state:record.state,gatewayInstanceId,...exportResult(record.result??{ok:false,error:record.failureReason},page)};
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

  return { submit, get, getResult, list, cancel, get size() { return records.size; } };
}
