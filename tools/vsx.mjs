import { Sandbox } from "@vercel/sandbox";
import { readFileSync } from "node:fs";
const cfg = JSON.parse(readFileSync(process.env.HOME + "/.config/sandhop/config.json", "utf8")).credentials;
const creds = { token: cfg.VERCEL_TOKEN, teamId: cfg.VERCEL_TEAM_ID, projectId: cfg.VERCEL_PROJECT_ID };
const sb = await Sandbox.create({ ...creds, timeout: 600000, runtime: "node26", resources: { vcpus: 2 }, ports: [7681], persistent: false });
try {
  const r = await sb.runCommand({ cmd: "bash", args: ["-lc", "echo hi"], sudo: true, timeoutMs: 86400000 });
  console.log("24h-timeout exit", r.exitCode);
} catch (e) { console.log("24h-timeout FAIL:", String(e).slice(0, 140)); }
await sb.stop();
