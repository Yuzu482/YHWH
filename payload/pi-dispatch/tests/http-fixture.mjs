import {randomInt} from 'node:crypto';
import {createServer} from 'node:http';

// listen(0) may allocate a WHATWG Fetch blocked port on hosts whose dynamic
// TCP range starts below 49152. Keep the listening socket reserved throughout
// the test, and retry only bind collisions/permissions, never HTTP requests.
// https://fetch.spec.whatwg.org/#port-blocking
export async function listenHttpFixture(listener, {
  choosePort = () => randomInt(49152, 65536), maxAttempts = 16,
} = {}) {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 64)
    throw new RangeError('Invalid HTTP fixture bind budget');
  let lastError;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const port = choosePort();
    if (!Number.isInteger(port) || port < 49152 || port > 65535)
      throw new RangeError('HTTP fixture port must be between 49152 and 65535');
    const server = createServer(listener);
    try {
      await new Promise((resolve, reject) => {
        const onError = error => { server.off('listening', onListening); reject(error); };
        const onListening = () => { server.off('error', onError); resolve(); };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen({port, host:'127.0.0.1', exclusive:true});
      });
      return server;
    } catch (error) {
      if (!['EADDRINUSE','EACCES'].includes(error.code)) throw error;
      lastError = error;
    }
  }
  throw Object.assign(new Error(`HTTP fixture bind failed after ${maxAttempts} attempts`, {cause:lastError}),
    {code:lastError.code});
}
