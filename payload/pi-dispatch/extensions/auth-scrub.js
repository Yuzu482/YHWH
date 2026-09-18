import { unlinkSync } from 'node:fs';

export default function authScrubExtension(pi) {
  pi.on('agent_settled', () => {
    const authPath = process.env.PI_SANDBOX_AUTH_PATH;
    if (!authPath) return;
    try { unlinkSync(authPath); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    delete process.env.PI_SANDBOX_AUTH_PATH;
  });
}
