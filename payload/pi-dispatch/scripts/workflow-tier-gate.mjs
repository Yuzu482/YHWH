import * as z from 'zod/v4';
import { classifyWorkflowTier, parseUnifiedPatch, validateDeclaredWorkflowTier } from '../extensions/workflow-tier.js';
import { canonicalRole } from '../extensions/role-contract.js';

const tiers = ['T0', 'T1', 'T2'];

export const tierDeclarationSchema = z.object({
  publicApiOrProtocol: z.boolean(),
  dependencyOrLockfile: z.boolean(),
  securityAuthOrCredentials: z.boolean(),
  migration: z.boolean(),
  irreversibleOrNoRollback: z.boolean(),
}).strict();

export const workflowTierFieldsSchema = z.object({
  tier: z.enum(tiers).optional(),
  tierDeclaration: tierDeclarationSchema.optional(),
}).strict();

function invalid(code, message) {
  throw Object.assign(new Error(message), { code });
}

export function validateWriteTier(input, requireTopic, riskProfile = 'standard') {
  if (input?.access !== 'workspace-write') return null;
  if (!tiers.includes(input.tier) || input.tierDeclaration === undefined) {
    invalid('WORKFLOW_TIER_REQUIRED', 'workspace-write requires tier and tierDeclaration');
  }
  const parsed = tierDeclarationSchema.safeParse(input.tierDeclaration);
  if (!parsed.success) invalid('WORKFLOW_TIER_INVALID', parsed.error.issues[0]?.message ?? 'Invalid tier declaration');
  const declaration = parsed.data;
  if (Object.hasOwn(input, 'riskProfile')) invalid('WORKFLOW_TIER_INVALID', 'riskProfile is host-configured only');
  let validated;
  try {
    validated = validateDeclaredWorkflowTier(declaration, input.tier, input.task?.writeScope);
  } catch (error) {
    invalid('WORKFLOW_TIER_INVALID', error.message);
  }
  const profileTier = riskProfile === 'critical' && validated.level === 'T0' ? 'T1'
    : riskProfile === 'personal' && validated.level === 'T2' ? 'T1' : validated.level;
  const minimum = riskProfile === 'critical' && validated.minimumLevel === 'T0' ? 'T1'
    : riskProfile === 'personal' && validated.minimumLevel === 'T2' ? 'T1' : validated.minimumLevel;
  if (!['standard','personal','critical'].includes(riskProfile)) invalid('WORKFLOW_TIER_INVALID', 'Unknown host risk profile');
  if (['T0','T1','T2'].indexOf(input.tier) < ['T0','T1','T2'].indexOf(profileTier)) invalid('WORKFLOW_TIER_INVALID', `Declared tier ${input.tier} is below profile-adjusted minimum ${profileTier}`);
  const effectiveDeclared = riskProfile === 'personal' && input.tier === 'T2' ? 'T1' : input.tier;
  if (effectiveDeclared === 'T2') {
    if (canonicalRole(input.task?.role) !== 'Chesed' || input.task?.handoff?.version !== 2
        || input.task?.handoff?.stage !== 'implementing'
        || !input.task.handoff.inputs?.some(ref => ref.stage === 'pre-review' && ref.role === 'Geburah')) {
      invalid('WORKFLOW_TIER_PRE_REVIEW_REQUIRED', 'T2 requires a linked v2 implementing task with a Geburah pre-review input');
    }
    if (typeof requireTopic !== 'function') invalid('WORKFLOW_TIER_INVALID', 'A task-tiers receipt verifier is required for T2');
    requireTopic('task-tiers', input.workflowReceipt);
  }
  return { level: effectiveDeclared, minimumLevel: minimum, requiresPreReview: effectiveDeclared === 'T2', requiresPostReview: effectiveDeclared !== 'T0' };
}

export function classifyPatchTier(patch, declaration, riskProfile = 'standard', trustedFiles = undefined) {
  const parsed = parseUnifiedPatch(patch);
  const parsedFiles = parsed.flatMap(section => section.files);
  if (trustedFiles !== undefined) {
    if (!Array.isArray(trustedFiles) || trustedFiles.length !== parsedFiles.length
        || new Set(trustedFiles).size !== trustedFiles.length
        || parsedFiles.some(path => !trustedFiles.includes(path))) invalid('PI_PATCH_INVALID', 'Trusted changed-file proof does not exactly match patch sections');
  }
  const files = parsedFiles;
  const addedLines = parsed.reduce((sum, section) => sum + section.addedLines, 0);
  const deletedLines = parsed.reduce((sum, section) => sum + section.deletedLines, 0);
  const sharedPath = files.some(path => /(?:^|\/)(?:shared|common|core)(?:\/|$)/i.test(path));
  return { ...classifyWorkflowTier({ files, addedLines, deletedLines, declaration, riskProfile, sharedPath }), semanticRisks: { publicApiOrProtocol:declaration.publicApiOrProtocol, dependencyOrLockfile:declaration.dependencyOrLockfile, securityAuthOrCredentials:declaration.securityAuthOrCredentials, migration:declaration.migration, irreversibleOrNoRollback:declaration.irreversibleOrNoRollback } };
}

export function validateT0Patch(patch) {
  try { return classifyPatchTier(patch, { publicApiOrProtocol:false, dependencyOrLockfile:false, securityAuthOrCredentials:false, migration:false, irreversibleOrNoRollback:false }).effective === 'T0'; }
  catch { return false; }
}

export function tierResponseMetadata(tier) {
  const metadata = typeof tier === 'string' ? { effective:tier } : tier;
  if (!tiers.includes(metadata.effective)) invalid('WORKFLOW_TIER_INVALID', 'Unknown tier');
  return { tier:metadata.effective, reviewPending:metadata.effective !== 'T0', files:metadata.files, addedLines:metadata.addedLines, deletedLines:metadata.deletedLines, estimatedLines:metadata.estimatedLines, baseTier:metadata.base, riskProfile:metadata.riskProfile, semanticRisks:metadata.semanticRisks };
}

export function tierContractMetadata(tier) {
  const metadata = typeof tier === 'string' ? { effective:tier } : tier;
  return { ...tierResponseMetadata(metadata), reviewRequirement: metadata.effective === 'T0' ? 'none' : 'independent post-review required' };
}
