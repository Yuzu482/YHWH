import {randomBytes} from 'node:crypto';

// A receipt proves retrieval from this gateway instance, not comprehension or host identity.
export function createWorkflowReceipts({ttlMs=30*60*1000,maxEntries=1024,now=Date.now}={}) {
  if(!Number.isSafeInteger(ttlMs)||ttlMs<1||!Number.isSafeInteger(maxEntries)||maxEntries<1||typeof now!=='function')throw new Error('Invalid workflow receipt limits');
  const entries=new Map();
  const prune=()=>{
    const time=now();
    for(const [token,entry] of entries) if(entry.expiresAt<=time) entries.delete(token);
    while(entries.size>=maxEntries) entries.delete(entries.keys().next().value);
  };
  return {
    issue(topic,sha256){
      prune();
      const receipt=randomBytes(32).toString('base64url');
      const expiresAt=now()+ttlMs;
      entries.set(receipt,{topic,sha256,expiresAt});
      return {receipt,receiptExpiresAt:new Date(expiresAt).toISOString()};
    },
    check(topic,sha256,receipt){
      if(typeof receipt!=='string'||!receipt) return false;
      const entry=entries.get(receipt);
      if(!entry) return false;
      if(entry.expiresAt<=now()){entries.delete(receipt);return false;}
      return entry.topic===topic&&entry.sha256===sha256;
    },
    clear(){entries.clear();},
  };
}
