// Deterministic planning only: no model calls, credentials, filesystem or timers.
export const COMPLEXITY_PREFIX = 'TASK_COMPLEXITY_JSON=';
export const TASK_PLANNING_POLICY = Object.freeze({
  version: 1, assessmentPrefix: COMPLEXITY_PREFIX,
  automaticLevels: Object.freeze(['low', 'medium', 'high']), defaultThinking: 'medium',
  explicitThinkingPreserved: true, scopeAdvisory: true,
  scopeTargets: Object.freeze({ writeFiles: 3, readFiles: 8 }),
});

const strings = value => Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];
const unique = value => [...new Set(strings(value))];
const treeScope = paths => paths.some(path => path.includes('*'));
const observable = /\b(?:exit(?:\s+code)?\s*[:=]?\s*\d+|asserts?|equals?|matches?|contains?|rejects?|throws?|passes?|unchanged)\b|退出码|等于|包含|拒绝|断言|通过|保持/u;

export function inspectTaskPlanning(task) {
  const reads = unique(task?.readScope), writes = unique(task?.writeScope);
  const acceptance = strings(task?.acceptance);
  const entries = strings(task?.context).filter(entry => entry.startsWith(COMPLEXITY_PREFIX));
  const tierReasons=strings(task?.context).filter(entry=>entry.startsWith('TIER_REASON='));
  const tierReason=tierReasons.length===1?tierReasons[0].slice('TIER_REASON='.length).trim():'';
  const meaningfulTierReason=tierReason.length>=24&&!/^(?:because it is risky|be safe|high risk|important)$/i.test(tierReason);
  let assessment = null, assessmentState = entries.length ? 'invalid' : 'missing';
  if (entries.length === 1 && entries[0].length <= 2048) {
    try {
      const value = JSON.parse(entries[0].slice(COMPLEXITY_PREFIX.length));
      if (value && typeof value === 'object' && !Array.isArray(value) &&
          Object.keys(value).length === 4 && ['changeKind', 'uncertainty', 'coupling', 'reason'].every(key => Object.hasOwn(value, key)) &&
          ['exact', 'bounded', 'design', 'diagnosis'].includes(value.changeKind) &&
          ['none', 'localized', 'unresolved'].includes(value.uncertainty) &&
          ['local', 'cross-file', 'concurrent'].includes(value.coupling) &&
          typeof value.reason === 'string' && value.reason.trim() && value.reason.length <= 400) {
        assessment = value; assessmentState = 'provided';
      }
    } catch { /* Missing/invalid assessment stays conservative; it grants no authority. */ }
  }
  const broadScope = writes.length > 3 || reads.length > 8 || treeScope([...reads, ...writes]);
  const concreteAcceptance = acceptance.length > 0 && acceptance.every(item => observable.test(item.toLowerCase()));
  const reasonCodes = [];
  let recommendedThinking = 'medium';
  if (!assessment) reasonCodes.push(assessmentState === 'invalid' ? 'invalid_assessment' : 'assessment_missing');
  else if (assessment.uncertainty === 'unresolved' || assessment.coupling === 'concurrent' ||
      assessment.changeKind === 'design' && assessment.coupling === 'cross-file') {
    recommendedThinking = 'high'; reasonCodes.push('uncertain_or_interacting_design');
  } else if (assessment.changeKind === 'exact' && assessment.uncertainty === 'none' && assessment.coupling === 'local' &&
      writes.length <= 2 && reads.length <= 4 && !broadScope && concreteAcceptance && !strings(task?.dependencies).length && !strings(task?.assumptions).length) {
    recommendedThinking = 'low'; reasonCodes.push('exact_bounded_observable');
  } else reasonCodes.push('bounded_or_insufficient_low_evidence');
  return {
    assessmentState, recommendedThinking, reasonCodes,
    scope: { readFiles: reads.length, writeFiles: writes.length, broad: broadScope },
    tierAdvice:{classificationRequiresWholeTaskAssessment:!meaningfulTierReason,reasonCode:meaningfulTierReason?'whole_task_reason_provided':'classify_whole_task'},
    acceptance: { count: acceptance.length, observable: concreteAcceptance },
  };
}

export function selectTaskThinking({ task, provider, thinking, defaultThinking = 'medium', probe = false }) {
  const plan = inspectTaskPlanning(task);
  // Only native workers adapt. Reviewers, probes and controlled transports keep their policies.
  const adaptive = !probe && provider === 'openai-codex' && !['Geburah', 'reviewer'].includes(task?.role);
  const selectedThinking = thinking ?? (adaptive ? plan.recommendedThinking : defaultThinking);
  return {
    version: 1, selectedThinking,
    source: thinking !== undefined ? 'explicit' : adaptive ? 'adaptive' : 'provider-default',
    recommendedThinking: adaptive ? plan.recommendedThinking : defaultThinking,
    assessmentState: plan.assessmentState,
    tierAdvice:plan.tierAdvice,
    reasonCodes: thinking !== undefined ? ['explicit_selection'] : adaptive ? plan.reasonCodes : ['route_policy_preserved'],
  };
}
