import { realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute, sep } from 'node:path';

export default function readGuard(pi) {
  pi.on('tool_call', async (event, ctx) => {
    if (['bash','powershell'].includes(event.toolName)) return {block:true,reason:'Shell execution is disabled'};
    // The mounted workspace already contains only the admitted read/write union.
    for (const key of ['path','file','filePath','directory','cwd']) {
      const value=event.input?.[key];
      if (typeof value!=='string') continue;
      try {
        const root=realpathSync(ctx.cwd);
        const target=resolve(root,value);
        const rel=relative(root,target);
        if (isAbsolute(rel)||rel==='..'||rel.startsWith('..'+sep)) throw Error();
        // Reject links and existing targets outside the workspace too.
        let real;
        try {real=realpathSync(target);} catch(e) {if(e.code!=='ENOENT') throw e;}
        if (real) {const r=relative(root,real);if(isAbsolute(r)||r==='..'||r.startsWith('..'+sep)) throw Error();}
      } catch {return {block:true,reason:'Tool path must stay in the admitted workspace'};}
    }
  });
}
