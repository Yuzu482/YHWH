import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createGatewayRuntime } from './gateway.mjs';
import {startStdioProxy} from './stdio-proxy.mjs';

function roots(env = process.env) {
  const value = JSON.parse(env.PI_GATEWAY_ROOTS || '[]');
  if (!Array.isArray(value) || value.length === 0 || value.some(root => typeof root !== 'string')) throw new Error('PI_GATEWAY_ROOTS must be a non-empty JSON string array');
  return value.map(root => realpathSync(resolve(root)));
}

try {
  if(process.env.PI_GATEWAY_CONFIG){
    const bridge=await startStdioProxy({configPath:process.env.PI_GATEWAY_CONFIG});
    const stop=()=>{void bridge.close().finally(()=>process.exit(0));};
    process.stdin.once('end',stop);process.stdin.once('close',stop);
    process.once('SIGINT',stop);process.once('SIGTERM',stop);
  } else {
  const auditFile = process.env.PI_GATEWAY_AUDIT_FILE;
  if (!auditFile) throw new Error('PI_GATEWAY_AUDIT_FILE is required');
  const providerCircuitFile = process.env.PI_GATEWAY_PROVIDER_CIRCUIT_FILE;
  if (!providerCircuitFile) throw new Error('PI_GATEWAY_PROVIDER_CIRCUIT_FILE is required');
  const requestLedgerDir = process.env.PI_GATEWAY_REQUEST_LEDGER_DIR;
  if (!requestLedgerDir) throw new Error('PI_GATEWAY_REQUEST_LEDGER_DIR is required');
  const runtime = createGatewayRuntime({ host: 'stdio', port: 0, bind: 'stdio', protocol: 'MCP stdio', roots: roots(), maxConcurrency: 4, maxQueue: 16, auditFile, providerCircuitFile, requestLedgerDir });
  const server = runtime.makeServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await runtime.shutdown({ graceMs: 10_000, abortWaitMs: 20_000 });
      await transport.close();
      await server.close();
      process.exit(0);
    } catch (error) {
      console.error(JSON.stringify({ ok: false, event: 'graceful_shutdown_failed', error: error.message }));
      process.exit(1);
    }
  };
  const transportClosed = transport.onclose;
  transport.onclose = () => {
    transportClosed?.();
    void stop();
  };
  process.stdin.once('end', () => { void stop(); });
  process.stdin.once('close', () => { void stop(); });
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  }
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error.message }));
  process.exitCode = 1;
}
