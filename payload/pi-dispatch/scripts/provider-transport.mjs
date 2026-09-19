// SPDX-License-Identifier: Apache-2.0
// Prevent credential forwarding by redirects and reject unconfigured destinations.
export function installTransportFence(packet, target=globalThis) {
  const original=target.fetch.bind(target);
  const endpoint=packet.route.baseUrl+(packet.route.protocol==='anthropic-messages'?'/v1/messages':'/responses');
  target.fetch=async (input,init={})=>{
    const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;
    if(url!==endpoint) throw new Error('PI_PROVIDER_ENDPOINT_REJECTED');
    return original(input,{...init,redirect:'error'});
  };
  // Strip even nonstandard aggregator secrets from streaming JSON/errors, across chunks.
  for(const stream of [process.stdout,process.stderr]) {
    const write=stream.write.bind(stream); let pending='';
    const emit=text=>write(text.split(packet.apiKey).join('[REDACTED]'));
    stream.write=(chunk,encoding,callback)=>{
      pending+=Buffer.isBuffer(chunk)?chunk.toString('utf8'):String(chunk);
      let i; while((i=pending.indexOf('\n'))>=0){emit(pending.slice(0,i+1));pending=pending.slice(i+1);}
      if(pending.length>1048576){pending=pending.split(packet.apiKey).join('[REDACTED]');const keep=packet.apiKey.length;emit(pending.slice(0,-keep));pending=pending.slice(-keep);}
      if(typeof encoding==='function')encoding();else callback?.();return true;
    };
    process.once('beforeExit',()=>{if(pending){emit(pending);pending='';}});
  }
}
