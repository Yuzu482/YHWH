// SPDX-License-Identifier: Apache-2.0
// No credentials, endpoints or commands cross this tool interface.
export const LSP_TOOLS = Object.freeze(['diagnostics','hover','definition','references','symbols','completions','code_actions']);

export default function lspProxy(pi) {
  let sequence = 0, tail = Promise.resolve(), queued = 0;
  pi.on('agent_end', () => {
    if (!queued && process.connected) process.disconnect();
  });
  for (const method of LSP_TOOLS) {
    const positioned = !['diagnostics','symbols'].includes(method);
    pi.registerTool({
      name: `yhwh_lsp_${method}`, label: `YHWH ${method}`,
      description: `Read-only ${method} through the YHWH multilspy adapter. Single-file snapshot of the current admitted task workspace; no model or network in the probe. Positions are 1-based UTF-16. ${positioned ? 'Supply line and character together, or an exact unique symbol query.' : method === 'symbols' ? 'Optional query matches a symbol name exactly.' : 'An empty result only counts when diagnostic evidence is complete.'} No edits or code actions are executed.`,
      parameters: {type:'object', properties:{
        path:{type:'string',minLength:1,maxLength:4096},
        ...(positioned ? {line:{type:'integer',minimum:1},character:{type:'integer',minimum:1}} : {}),
        ...(method !== 'diagnostics' ? {query:{type:'string',minLength:1,maxLength:4000}} : {}),
      },required:['path'],additionalProperties:false},
      async execute(_id, params, signal) {
        if (queued >= 4) throw new Error('YHWH_LSP_QUEUE_FULL');
        queued++;
        const run = async () => {
          if (signal?.aborted) throw new Error('YHWH_LSP_CANCELLED');
          if (!process.connected || typeof process.send !== 'function') throw new Error('YHWH_LSP_REQUIRES_GOVERNED_SANDBOX');
          const lspId = ++sequence;
          const result = await new Promise((resolve, reject) => {
            const clear = () => { clearTimeout(timer); process.off('message', reply); process.off('disconnect', closed); signal?.removeEventListener('abort', abort); };
            const fail = code => { clear(); reject(new Error(code)); };
            const reply = message => { if (message?.lspId === lspId) { clear(); resolve(message.result); } };
            const closed = () => fail('YHWH_LSP_CHANNEL_CLOSED');
            const abort = () => { if (process.connected) process.send({lspCancel:lspId}, () => {}); };
            const timer = setTimeout(() => { abort(); fail('YHWH_LSP_CHANNEL_TIMEOUT'); }, 70000);
            process.on('message', reply); process.once('disconnect', closed); signal?.addEventListener('abort', abort, {once:true});
            process.send({lspId,tool:`lsp_${method}`,params}, error => { if (error) fail('YHWH_LSP_CHANNEL_CLOSED'); });
            if (signal?.aborted) abort();
          });
          return {content:[{type:'text',text:JSON.stringify(result)}],details:result,isError:result?.ok !== true};
        };
        const work = tail.then(run); tail = work.catch(() => {});
        try { return await work; } finally { queued--; }
      },
    });
  }
}
