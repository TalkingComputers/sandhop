import { fileURLToPath, pathToFileURL } from "node:url";
import {
  detectAgents,
  pickAgent,
  selectDefaultAgent,
} from "../agents/index.js";
import { AuthService } from "../core/services/auth.js";
import { BootstrapService } from "../core/services/bootstrap.js";
import { SecretsService } from "../core/services/secrets.js";
import { SessionService } from "../core/services/session.js";
import { SnapshotService } from "../core/services/snapshot.js";
import { TeleportService } from "../core/services/teleport.js";
import { VersionService } from "../core/services/version.js";
import { NodeHost } from "../host/node.js";
import { buildProvider } from "../providers/index.js";
import { buildTransport, parseArgs } from "./args.js";

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
  const provider = buildProvider(args.provider, host);
  const agent = args.agent
    ? pickAgent(args.agent)
    : selectDefaultAgent(detectAgents(host, args.cwd));
  const sessions = agent.matchSession(host, args.cwd);
  if (sessions.length === 0)
    throw new Error(
      args.agent === undefined
        ? `No Claude Code or Codex session found for ${args.cwd}`
        : `No ${agent.id} session found for ${args.cwd}`,
    );
  if (args.agent === undefined && detectAgents(host, args.cwd).length > 1)
    console.error(`Multiple agents found; using ${agent.id}`);
  const service = new TeleportService(provider, agent, {
    host,
    snapshot: new SnapshotService(host),
    session: new SessionService(host, agent),
    secrets: new SecretsService(host, agent),
    auth: new AuthService(host, agent),
    version: new VersionService(host, agent),
    bootstrap: new BootstrapService(agent),
  });
  const result = await service.run(args.cwd, {
    sessionId: args.session,
    profile: args.profile,
    transport: buildTransport(args, process.env),
    timeoutMs: 3_600_000,
    onProgress,
  });
  console.log(`KEEPON_URL ${result.url}`);
  console.log(`KEEPON_AUTH ${result.user}:${result.pass}`);
  console.log(`KEEPON_ENRICHING ${result.sandboxId}`);
  console.log(
    "enrichment running in background (profile, skills, MCP servers)",
  );
  const enrichPath = fileURLToPath(new URL("./enrich.js", import.meta.url));
  host.spawnDetached(
    process.execPath,
    [
      enrichPath,
      "--sandbox-id",
      result.sandboxId,
      "--agent",
      agent.id,
      "--cwd",
      args.cwd,
      "--provider",
      args.provider,
      ...(args.profile ? [] : ["--no-profile"]),
    ],
    { cwd: args.cwd, env: process.env },
  );
};

export const main = async (argv: string[]): Promise<void> => {
  const args = parseArgs(argv, process.cwd());
  if (args.cmd === "list") {
    const provider = buildProvider(args.provider, buildHost());
    for (const sandbox of await provider.list())
      console.log(`${sandbox.id}\t${sandbox.startedAt.toISOString()}`);
    return;
  }
  if (args.cmd === "kill") {
    const provider = buildProvider(args.provider, buildHost());
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
