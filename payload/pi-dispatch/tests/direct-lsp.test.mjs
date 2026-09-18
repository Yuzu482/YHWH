import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {lspParameters} from '../scripts/direct-lsp.mjs';

test('direct LSP maps structured positions and patterns without interpreting prompts',()=>{
  assert.deepEqual(lspParameters({method:'hover',line:2,character:4},'a.py'),{path:'a.py',line:2,character:4});
  assert.deepEqual(lspParameters({method:'search',query:'print($A)',language:'python'},'a.py'),{path:'a.py',pattern:'print($A)',language:'python'});
  assert.throws(()=>lspParameters({method:'hover',line:2},'a.py'),/both/);
  assert.throws(()=>lspParameters({method:'hover'},'a.py'),/Provide/);
  assert.throws(()=>lspParameters({method:'search',query:'x'},'a.py'),/language/);
  assert.throws(()=>lspParameters({method:'rename'},'a.py'),/Unsupported/);
  assert.throws(()=>lspParameters({method:'diagnostics',query:'do something'},'a.py'),/does not accept/);
});

test('direct LSP launcher is read-only and has an isolated credential-free branch',()=>{
  const launcher=readFileSync(new URL('../sandbox/pi-kether-sandbox',import.meta.url),'utf8');
  assert.match(launcher,/direct LSP requires read access/);
  assert.match(launcher,/network_args=\(--unshare-net\)/);
  assert.match(launcher,/if \[\[ "\$direct_lsp" == true \]\]; then\n    printf '\{\}'/);
  assert.match(launcher,/bootstrap=\/opt\/pi-kether\/scripts\/direct-lsp-bootstrap.mjs/);
});
