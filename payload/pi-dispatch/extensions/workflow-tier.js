const RISK_KEYS = ['publicApiOrProtocol', 'dependencyOrLockfile', 'securityAuthOrCredentials', 'migration', 'irreversibleOrNoRollback', 'uncertainFileScope'];
const DECLARATION_KEYS = ['files', 'estimatedLines', 'isTestOrConfigChange', ...RISK_KEYS];
const TIERS = ['T0', 'T1', 'T2'];

function invalid(message) {
  throw Object.assign(new Error(message), { code: 'WORKFLOW_TIER_INVALID' });
}

function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function validFiles(files) {
  return Array.isArray(files) && files.length > 0
    && files.every(file => typeof file === 'string'
      && /^(?!\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(file))
    && new Set(files).size === files.length;
}

function validateDeclaration(declaration) {
  if (!exactKeys(declaration, DECLARATION_KEYS)) invalid('Invalid workflow tier declaration keys');
  if (!validFiles(declaration.files)) invalid('Files must be exact, unique relative paths without wildcards or traversal');
  if (!Number.isSafeInteger(declaration.estimatedLines) || declaration.estimatedLines < 0) invalid('estimatedLines must be a non-negative safe integer');
  if (RISK_KEYS.some(key => typeof declaration[key] !== 'boolean') || typeof declaration.isTestOrConfigChange !== 'boolean') invalid('Risk flags must be booleans');
}

export function validateWorkflowTier(declaration) {
  validateDeclaration(declaration);
  const t2 = RISK_KEYS.some(key => declaration[key]);
  const t1 = declaration.files.length > 1 || declaration.estimatedLines > 20 || declaration.isTestOrConfigChange;
  const level = t2 ? 'T2' : t1 ? 'T1' : 'T0';
  return { level, requiresPreReview: level === 'T2', requiresPostReview: level !== 'T0' };
}

export function validateDeclaredWorkflowTier(declaration, declaredLevel, writeScope) {
  if (!TIERS.includes(declaredLevel)) invalid('Unknown declared workflow tier');
  const required = validateWorkflowTier(declaration);
  if (!validFiles(writeScope) || writeScope.length !== declaration.files.length
      || writeScope.some(file => !declaration.files.includes(file))) {
    invalid('Declared files must exactly match invocation writeScope');
  }
  if (TIERS.indexOf(declaredLevel) < TIERS.indexOf(required.level)) {
    invalid(`Declared tier ${declaredLevel} is below minimum tier ${required.level}`);
  }
  const level = declaredLevel;
  return { declaredLevel, minimumLevel: required.level, level,
    requiresPreReview: level === 'T2', requiresPostReview: level !== 'T0' };
}
