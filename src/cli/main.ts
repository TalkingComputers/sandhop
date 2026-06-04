import { fileURLToPath, pathToFileURL } from "node:url";
import {
  detectAgents,
  pickAgent,
  selectDefaultAgent,
} from "../agents/index.js";
import type { Agent } from "../core/ports/agent.js";
import { AuthService } from "../core/services/auth.js";
import { BootstrapService } from "../core/services/bootstrap.js";
import { SecretsService } from "../core/services/secrets.js";
import { SessionService } from "../core/services/session.js";
import { SnapshotService } from "../core/services/snapshot.js";
import { TeleportService } from "../core/services/teleport.js";
import { VersionService } from "../core/services/version.js";
import type { NodeHost } from "../host/node.js";
import { buildProvider, type ProviderId } from "../providers/index.js";
import {
  buildTransport,
  parseArgs,
  readProvider,
  readTransport,
  type ParsedArgs,
} from "./args.js";
import {
  applyConfigToEnv,
  loadConfig,
  type KeeponTransport,
} from "./config.js";
import { buildHost } from "./host.js";
import { runSetup } from "./setup.js";

type RuntimeArgs = Omit<ParsedArgs, "provider" | "transport"> & {
  provider: ProviderId;
  transport: KeeponTransport;
};

const withRuntimeDefaults = (args: ParsedArgs, host: NodeHost): RuntimeArgs => {
  const config = loadConfig(host.home);
  if (config !== null) applyConfigToEnv(config, host.env);
  return {
    ...args,
    provider: args.provider ?? readProvider(host.env["KEEPON_PROVIDER"]),
    transport: args.transport ?? readTransport(host.env["KEEPON_TRANSPORT"]),
  };
};

const runPush = async (
  args: RuntimeArgs,
  host: NodeHost,
  onProgress: (msg: string) => void,
): Promise<void> => {
  const provider = buildProvider(args.provider, host);
  const detected =
    args.agent === undefined ? detectAgents(host, args.cwd) : undefined;
  let agent: Agent;
  if (args.agent === undefined) {
    if (detected === undefined) throw new Error("Agent detection failed");
    agent = selectDefaultAgent(detected);
  } else {
    agent = pickAgent(args.agent);
  }
  const sessions = agent.matchSession(host, args.cwd);
  if (sessions.length === 0)
    throw new Error(
      args.agent === undefined
        ? `No Claude Code or Codex session found for ${args.cwd}`
        : `No ${agent.id} session found for ${args.cwd}`,
    );
  if (detected !== undefined && detected.length > 1)
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
  if (args.cmd === "setup") {
    await runSetup(buildHost());
    return;
  }
  const host = buildHost();
  const runtimeArgs = withRuntimeDefaults(args, host);
  if (args.cmd === "list") {
    const provider = buildProvider(runtimeArgs.provider, host);
    for (const sandbox of await provider.list())
      console.log(`${sandbox.id}\t${sandbox.startedAt.toISOString()}`);
    return;
  }
  if (args.cmd === "kill") {
    const provider = buildProvider(runtimeArgs.provider, host);
    if (args.killId === undefined)
      throw new Error("kill requires a sandbox id");
    console.log((await provider.destroy(args.killId)) ? "killed" : "not found");
    return;
  }
  await runPush(runtimeArgs, host, (msg) => console.error(msg));
  process.exit(0);
};

const formatCliError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  if (
    message.startsWith("--provider must") ||
    message.includes(" is required for ") ||
    message.includes("API key")
  )
    return `${message}\nRun \`keepon setup\` to configure a provider.`;
  return message;
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(formatCliError(error));
    process.exit(1);
  });
