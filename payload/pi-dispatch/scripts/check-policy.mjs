const ID = /^[a-z][a-z0-9-]{0,63}$/;
const EXECUTABLE = /^[-a-zA-Z0-9_]+$/;
const DENIED_EXECUTABLES = new Set(['sh','bash','dash','zsh','cmd','powershell','pwsh','env','sudo']);
const forbiddenArg = /[\u0000\u0001-\u001f\u007f-\u009f;|&><`$]/u;

function exactObject(value, keys, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) throw new Error(`Invalid ${name}`);
}
function safeRelative(value, name, directory = false) {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.includes('\\') || /[\u0000-\u001f\u007f-\u009f:*?"<>|]/u.test(value)) throw new Error(`Invalid ${name}`);
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' && parts.length > 1 || part === '..')) throw new Error(`Invalid ${name}`);
  if (value !== '.' && (value.startsWith('/') || parts.some(part => part === '.'))) throw new Error(`Invalid ${name}`);
  if (directory && value !== '.' && value.endsWith('/')) throw new Error(`Invalid ${name}`);
  return value;
}
function argvValid(argv) {
  if (!Array.isArray(argv) || argv.length < 1 || argv.length > 32) return false;
  let bytes = 0;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (typeof arg !== 'string' || !arg || Buffer.byteLength(arg, 'utf8') > 2048 || forbiddenArg.test(arg) || i > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(arg)) return false;
    bytes += Buffer.byteLength(arg, 'utf8');
    if (i === 0 ? !EXECUTABLE.test(arg) || DENIED_EXECUTABLES.has(arg.toLowerCase()) : arg.startsWith('/') || arg.split('/').includes('..') || arg.includes('\\')) return false;
  }
  return bytes <= 16384;
}
export function validateVerify(value) {
  if (value === undefined) return undefined;
  exactObject(value, ['commands'], 'verify');
  if (!Array.isArray(value.commands) || value.commands.length < 1 || value.commands.length > 16) throw new Error('Invalid verify commands');
  const ids = new Set();
  const commands = value.commands.map(command => {
    exactObject(command, ['id', 'argv', 'cwd'], 'verify command');
    if (typeof command.id !== 'string' || !ID.test(command.id) || ids.has(command.id) || !argvValid(command.argv)) throw new Error('Invalid verify command');
    ids.add(command.id);
    return {id: command.id, argv: [...command.argv], cwd: safeRelative(command.cwd, 'verify cwd', true)};
  });
  return {commands};
}
function validWorkspace(value) {
  if (typeof value !== 'string' || /[\\\u0000-\u001f\u007f-\u009f*?<>|]/u.test(value)) return false;
  const posix = value.startsWith('/') && !value.startsWith('//');
  const drive = /^[A-Z]:\//u.test(value);
  if (!posix && !drive) return false;
  const rest = drive ? value.slice(3) : value.slice(1);
  if (!rest) return true;
  return rest.split('/').every(part => part && part !== '.' && part !== '..' && !/[. ]$/u.test(part));
}
export function validateCheckPolicy(value) {
  exactObject(value, ['version', 'projects'], 'check policy');
  if (value.version !== 1 || !Array.isArray(value.projects) || value.projects.length > 64) throw new Error('Invalid check policy');
  const workspaces = new Set();
  const projects = value.projects.map(project => {
    exactObject(project, ['workspace', 'commands'], 'policy project');
    if (!validWorkspace(project.workspace) || workspaces.has(project.workspace)) throw new Error('Invalid policy workspace');
    workspaces.add(project.workspace);
    if (!Array.isArray(project.commands) || project.commands.length > 64) throw new Error('Invalid policy commands');
    const tuples = new Set();
    const commands = project.commands.map(command => {
      exactObject(command, ['argv', 'cwd', 'runnerId', 'cacheId'], 'policy command');
      const cwd = safeRelative(command.cwd, 'policy cwd', true);
      if (!argvValid(command.argv) || typeof command.runnerId !== 'string' || !ID.test(command.runnerId) || typeof command.cacheId !== 'string' || !ID.test(command.cacheId)) throw new Error('Invalid policy command');
      const tuple = JSON.stringify([command.argv, cwd]);
      if (tuples.has(tuple)) throw new Error('Duplicate policy command');
      tuples.add(tuple);
      return {argv:[...command.argv], cwd, runnerId:command.runnerId, cacheId:command.cacheId};
    });
    return {workspace:project.workspace, commands};
  });
  return {version:1, projects};
}
export function authorizeRunChecks({verify, policy, workspace}) {
  const checked = validateVerify(verify);
  if (checked === undefined) return undefined;
  let admitted;
  try { admitted = validateCheckPolicy(policy); } catch { throw Object.assign(new Error('Check policy unavailable'), {code:'PI_CHECK_POLICY_UNAVAILABLE'}); }
  const project = admitted.projects.find(item => item.workspace === workspace);
  if (!project) throw Object.assign(new Error('Check project unavailable'), {code:'PI_CHECK_POLICY_UNAVAILABLE'});
  return checked.commands.map(command => {
    const match = project.commands.find(item => item.cwd === command.cwd && JSON.stringify(item.argv) === JSON.stringify(command.argv));
    if (!match) throw Object.assign(new Error('Check command denied'), {code:'PI_CHECK_COMMAND_DENIED'});
    return {id:command.id, argv:[...match.argv], cwd:match.cwd, runnerId:match.runnerId, cacheId:match.cacheId};
  });
}
