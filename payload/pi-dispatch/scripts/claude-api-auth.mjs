// SPDX-License-Identifier: Apache-2.0
import {prepareWindowsApiPacket} from './windows-api-credential.mjs';
export const CLAUDE_API_POLICY=Object.freeze({authentication:'api_key',hostOnly:true,atRestEncryption:'Windows DPAPI CurrentUser',plaintextFallback:false,subscriptionCredentials:false,automaticRenewal:false,networkValidation:false});
export async function checkClaudeAuth({env=process.env,signal}={}) {
 await prepareWindowsApiPacket({provider:'anthropic'},{env,signal});
 return {ok:true,status:'configured',authentication:'api_key',atRestEncryption:'Windows DPAPI CurrentUser',networkValidated:false,modelCalls:0};
}
