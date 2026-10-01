// Advisory heuristics only. Never return task content, paths, or credentials.
export const PREFLIGHT_MESSAGES = Object.freeze({
  script_without_real_run: 'Include a real interpreter run or smoke test in acceptance.',
  output_without_parent_path: 'Specify the output path including its parent directory and cleanup policy.',
  mixed_layers: 'Consider separate data, pure logic, and I/O tasks.',
  missing_interface_contract: 'Add an 接口约定 section with invocation, named arguments, success, and cleanup rules.',
});

export function summarizeRuntimePreflight(value) {
  const input=Array.isArray(value?.warnings)?value.warnings:[];
  const warnings = Object.keys(PREFLIGHT_MESSAGES).filter(code => input.some(item => item?.code === code))
    .map(code => ({code, message:PREFLIGHT_MESSAGES[code]}));
  return {advisory:true, warnings, counts:Object.fromEntries(warnings.map(({code}) => [code, 1]))};
}

export function runtimePreflight(task) {
  // Malformed inputs still belong to the existing validator, never this warning layer.
  try {
    const writes = Array.isArray(task?.writeScope) ? task.writeScope.filter(p => typeof p === 'string') : [];
    const contexts = Array.isArray(task?.context) ? task.context.filter(p => typeof p === 'string') : [];
    const acceptance = Array.isArray(task?.acceptance) ? task.acceptance.filter(p => typeof p === 'string').join('\n') : '';
    const text = [typeof task?.objective === 'string' ? task.objective : '', ...contexts].join('\n');
    const script = writes.some(p => /\.(?:[cm]?js|[cm]?ts|tsx|py|ps1|sh|bash)$/i.test(p));
    const codes = [];
    if (script && !/smoke|real (?:run|execution|interpreter)|\brun\b[^\n]*(?:node|python|npm|pnpm|powershell|pwsh|bash|test)|真实(?:运行|执行)|冒烟/i.test(acceptance)) codes.push('script_without_real_run');
    if (/output file|write (?:a |the )?(?:file|output)|generate[^\n]*file|输出文件|生成[^\n]*文件/i.test(text) && ![text, ...writes].some(p => /(?:^|[\s"'`])(?:[\w.-]+\/)+[\w.-]+(?:\.[\w]+)(?:$|[\s"'`,;])/u.test(p))) codes.push('output_without_parent_path');
    if (writes.length >= 3 && writes.some(p => /data|config|mapping|constant/i.test(p)) && writes.some(p => /logic|parse|transform|compute/i.test(p)) && writes.some(p => /cli|process|io|writer|runner/i.test(p))) codes.push('mixed_layers');
    if ((script || /subprocess|child.process|file|filesystem|port|子进程|文件|端口/i.test(text)) && !/接口约定|interface contract/i.test(contexts.join('\n'))) codes.push('missing_interface_contract');
    return summarizeRuntimePreflight({warnings:codes.map(code => ({code}))});
  } catch { return summarizeRuntimePreflight(null); }
}
