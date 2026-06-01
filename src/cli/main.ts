import { pathToFileURL } from "node:url";
import {
  detectAgents,
  pickAgent,
  selectDefaultAgent,
} from "../agents/index.js";
import { AuthService } from "../core/services/auth.js";
import { BootstrapService } from "../core/services/bootstrap.js";
import { ProfileService } from "../core/services/profile.js";
import { SecretsService } from "../core/services/secrets.js";
import { SessionService } from "../core/services/session.js";
import { SnapshotService } from "../core/services/snapshot.js";
import { TeleportService } from "../core/services/teleport.js";
import { VersionService } from "../core/services/version.js";
import { NodeHost } from "../host/node.js";
import { E2bSandboxProvider } from "../providers/e2b/index.js";
import { parseArgs, readTailscaleOption } from "./args.js";

const buildHost = (): NodeHost => {
  const home = process.env.HOME;
  if (home === undefined) throw new Error("HOME is required");
  return new NodeHost(process.env, home);
};

const runPush = async (
  args: ReturnType<typeof parseArgs>,
  onProgress: (msg: string) => void,
): Promise<void> => {
  const host = buildHost();
  const provider = new E2bSandboxProvider();
  const agent = args.agent
    ? pickAgent(args.agent)
    : selectDefaultAgent(detectAgents(host, args.cwd));
  const sessions = agent.matchSession(host, args.cwd);
  if (sessions.length === 0)
    throw new Error(`No Claude Code or Codex session found for ${args.cwd}`);
  if (args.agent === undefined && detectAgents(host, args.cwd).length > 1)
    console.error(`Multiple agents found; using ${agent.id}`);
  const service = new TeleportService(provider, agent, {
    host,
    snapshot: new SnapshotService(host),
    session: new SessionService(host, agent),
    profile: new ProfileService(host, agent),
    secrets: new SecretsService(host, agent),
    auth: new AuthService(host, agent),
    version: new VersionService(host, agent),
    bootstrap: new BootstrapService(agent),
  });
  const result = await service.run(args.cwd, {
    sessionId: args.session,
    profile: args.profile,
    tailscale: readTailscaleOption(args, process.env),
    timeoutMs: 3_600_000,
    onProgress,
  });
  console.log(`KEEPON_URL ${result.url}`);
  console.log(`KEEPON_AUTH ${result.user}:${result.pass}`);
};

export const main = async (argv: string[]): Promise<void> => {
  const args = parseArgs(argv, process.cwd());
  const provider = new E2bSandboxProvider();
  if (args.cmd === "list") {
    for (const sandbox of await provider.list())
      console.log(`${sandbox.id}\t${sandbox.startedAt.toISOString()}`);
    return;
  }
  if (args.cmd === "kill") {
    if (args.killId === undefined)
      throw new Error("kill requires a sandbox id");
    console.log((await provider.destroy(args.killId)) ? "killed" : "not found");
    return;
  }
  await runPush(args, (msg) => console.error(msg));
  process.exit(0);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(String(error instanceof Error ? error.message : error));
    process.exit(1);
  });
