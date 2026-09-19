// SPDX-License-Identifier: Apache-2.0
// Offline validation only; no secret loading or endpoint calls.
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {validateProviderConfig,readHostJson,configDigest} from '../payload/pi-dispatch/scripts/controlled-provider.mjs';
export function checkConfig(file) {
  const config=validateProviderConfig(readHostJson(file));
  return {ok:true,sha256:configDigest(config),providers:Object.keys(config.routes),modelCalls:0,networkValidated:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  try { if(process.argv.length!==3)throw new Error('Usage: node install/provider-config.mjs <config-file>'); console.log(JSON.stringify(checkConfig(process.argv[2]))); }
  catch(error){console.error(error.code||error.message);process.exitCode=1;}
}
