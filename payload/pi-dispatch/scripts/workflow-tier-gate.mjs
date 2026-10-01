import * as z from 'zod/v4';
import { validateDeclaredWorkflowTier } from '../extensions/workflow-tier.js';
import { canonicalRole } from '../extensions/role-contract.js';

const tiers = ['T0', 'T1', 'T2'];
const filePath = z.string().min(1).max(1024).regex(/^(?!\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/);

export const tierDeclarationSchema = z.object({
  files: z.array(filePath).min(1).max(32),
  estimatedLines: z.number().int().nonnegative().safe(),
  isTestOrConfigChange: z.boolean(),
  publicApiOrProtocol: z.boolean(),
  dependencyOrLockfile: z.boolean(),
  securityAuthOrCredentials: z.boolean(),
  migration: z.boolean(),
  irreversibleOrNoRollback: z.boolean(),
  uncertainFileScope: z.boolean(),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.files).size !== value.files.length) ctx.addIssue({ code: 'custom', message: 'Files must be unique' });
});

export const workflowTierFieldsSchema = z.object({
  tier: z.enum(tiers).optional(),
  tierDeclaration: tierDeclarationSchema.optional(),
}).strict();

function invalid(code, message) {
  throw Object.assign(new Error(message), { code });
}

export function validateWriteTier(input, requireTopic) {
  if (input?.access !== 'workspace-write') return null;
  if (typeof requireTopic !== 'function') invalid('WORKFLOW_TIER_INVALID', 'A task-tiers receipt verifier is required');
  requireTopic('task-tiers', input.workflowReceipt);
  if (!tiers.includes(input.tier) || input.tierDeclaration === undefined) {
    invalid('WORKFLOW_TIER_REQUIRED', 'workspace-write requires tier and tierDeclaration');
  }
  const parsed = tierDeclarationSchema.safeParse(input.tierDeclaration);
  if (!parsed.success) invalid('WORKFLOW_TIER_INVALID', parsed.error.issues[0]?.message ?? 'Invalid tier declaration');
  const declaration = parsed.data;
  let validated;
  try {
    validated = validateDeclaredWorkflowTier(declaration, input.tier, input.task?.writeScope);
  } catch (error) {
    invalid('WORKFLOW_TIER_INVALID', error.message);
  }
  const minimum = validated.minimumLevel;
  if (input.tier === 'T2' && (canonicalRole(input.task?.role) !== 'Chesed' || input.task?.handoff?.version !== 2
      || input.task?.handoff?.stage !== 'implementing'
      || !input.task.handoff.inputs?.some(ref => ref.stage === 'pre-review' && ref.role === 'Geburah'))) {
    invalid('WORKFLOW_TIER_PRE_REVIEW_REQUIRED', 'T2 requires a linked v2 implementing task with a Geburah pre-review input');
  }
  return { level: input.tier, minimumLevel: minimum, requiresPreReview: input.tier === 'T2', requiresPostReview: input.tier !== 'T0' };
}

export function validateT0Patch(patch) {
  if (typeof patch !== 'string' || !patch.trim()) return false;
  const lines = patch.split(/\r?\n/);
  const git = lines.some(line => line.startsWith('diff --git '));
  const starts = [];
  for (let i = 0; i < lines.length; i++) {
    if (git ? lines[i].startsWith('diff --git ') : /^diff -ruN\s/.test(lines[i])) starts.push(i);
  }
  if (starts.length !== 1) return false;
  const section = lines.slice(starts[0]);
  if (!section.some(line => line.startsWith('--- ')) || !section.some(line => line.startsWith('+++ '))
      || !section.some(line => line.startsWith('@@ '))) return false;
  let changed = 0;
  for (const line of section) {
    if (line.startsWith('\\ No newline at end of file')) continue;
    if ((line.startsWith('+') && !/^\+{3}(?: |\t)/.test(line))) changed++;
    else if ((line.startsWith('-') && !/^-{3}(?: |\t)/.test(line))) changed++;
  }
  return changed >= 1 && changed <= 20;
}

export function tierResponseMetadata(tier) {
  if (!tiers.includes(tier)) invalid('WORKFLOW_TIER_INVALID', 'Unknown tier');
  return { tier, reviewPending: tier !== 'T0' };
}

export function tierContractMetadata(tier) {
  return { ...tierResponseMetadata(tier), reviewRequirement: tier === 'T0' ? 'none' : 'independent post-review required' };
}
