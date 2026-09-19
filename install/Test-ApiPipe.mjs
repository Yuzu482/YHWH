// SPDX-License-Identifier: Apache-2.0
// Explicit optional WSL probe. Fixture data only; no filesystem/service changes or network.
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
const script=`set -euo pipefail
IFS= read -r -n 64 header
[[ "$header" == YHWH_API_CREDENTIAL_V1 ]]
IFS= read -r -n 32769 packet
(( \${#packet} <= 32768 ))
exec 3< <(printf '%s' "$packet")
unset packet
exec setpriv --reuid=pi-sandbox --regid=pi-sandbox --init-groups bwrap --die-with-parent --new-session --unshare-net --unshare-user --unshare-pid --unshare-uts --unshare-ipc --cap-drop ALL --ro-bind /usr /usr --ro-bind /bin /bin --ro-bind /lib /lib --ro-bind /lib64 /lib64 --ro-bind /opt /opt --dev /dev --tmpfs /tmp --dir /proc --dir /workspace --chdir /workspace --clearenv --setenv PATH /opt/node/bin:/usr/bin:/bin -- /opt/node/bin/node -e 'const fs=require("fs");const a=JSON.parse(fs.readFileSync(3,"utf8"));fs.closeSync(3);const p=fs.readFileSync(0,"utf8");if(a.fixture!=="not-a-real-key"||p!=="prompt-only\\n")process.exit(9);console.log("PASS: isolated FD3 pipe and separate prompt stdin; no credential file, no network")'
`;
const r=spawnSync('wsl.exe',['-d',process.argv[2]??'Ubuntu-24.04','-u','root','--exec','bash','-c',script],{input:'YHWH_API_CREDENTIAL_V1\n'+JSON.stringify({fixture:'not-a-real-key'})+'\nprompt-only\n',encoding:'utf8',timeout:20000});
console.log(r.stdout);console.error(r.stderr);assert.equal(r.status,0);
