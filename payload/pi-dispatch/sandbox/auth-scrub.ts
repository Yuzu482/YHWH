import { unlinkSync } from "node:fs";

export default function authScrubExtension(pi: any) {
  pi.on("agent_end", () => {
    const authPath = process.env.PI_SANDBOX_AUTH_PATH;
    if (!authPath) return;
    try {
      unlinkSync(authPath);
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
    delete process.env.PI_SANDBOX_AUTH_PATH;
  });
}
