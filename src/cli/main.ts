#!/usr/bin/env node
import { intro, note, outro, progress } from "@clack/prompts";
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  detectAgents,
  pickAgent,
  selectDefaultAgent,
} from "../agents/index.js";
import { CredentialError } from "../core/errors.js";
import type { Agent } from "../core/ports/agent.js";
import { AuthService } from "../core/services/auth.js";
import { BootstrapService } from "../core/services/bootstrap.js";
import { GitSshService } from "../core/services/git-ssh.js";
import { SecretsService } from "../core/services/secrets.js";
import { SessionService } from "../core/services/session.js";
import { TeleportService } from "../core/services/teleport.js";
import { VersionService } from "../core/services/version.js";
import type { NodeHost } from "../host/node.js";
import { TmuxMultiplexer } from "../multiplexers/tmux.js";
import { buildProvider, type ProviderId } from "../providers/index.js";
import {
  buildTransport,
  parseArgs,
  readProvider,
  readTransport,
  type ParsedArgs,
} from "./args.js";
import { applyConfigToEnv, loadConfig } from "./config.js";
import { buildHost } from "./host.js";
import { runSetup } from "./setup.js";

type RuntimeArgs = Omit<ParsedArgs, "provider"> & {
  provider: ProviderId;
};

type PushProgressBar = ReturnType<typeof progress> & {
  stop(msg?: string, code?: number): void;
};

export const withRuntimeDefaults = (
  args: ParsedArgs,
  host: NodeHost,
): RuntimeArgs => {
  const config = loadConfig(host.home);
  if (config !== null) applyConfigToEnv(config, host.env);
  return {
    ...args,
    provider: args.provider ?? readProvider(host.env["SANDHOP_PROVIDER"]),
  };
};

const formatPushProgress = (msg: string): string => {
  if (msg === "snapshotting") return "Snapshotting session";
  if (msg === "creating sandbox") return "Creating cloud sandbox";
  if (msg === "uploading bundle") return "Shipping working tree + session";
  if (msg === "restoring session") return "Restoring your session";
  if (msg.startsWith("installing"))
    return "Installing agent runtime + terminal";
  return msg;
};

const runPush = async (args: RuntimeArgs, host: NodeHost): Promise<void> => {
  const provider = buildProvider(args.provider, host);
  const transport =
    args.transport ?? readTransport(host.env["SANDHOP_TRANSPORT"]);
  const detected =
    args.agent === undefined ? detectAgents(host, args.cwd) : undefined;
  let agent: Agent;
  if (args.agent === undefined) {
    if (detected === undefined) throw new Error("Agent detection failed");
    agent = selectDefaultAgent(host, args.cwd, detected);
  } else {
    agent = pickAgent(args.agent);
  }
  const multiplexer = new TmuxMultiplexer();
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
    session: new SessionService(host, agent),
    secrets: new SecretsService(host, agent),
    auth: new AuthService(host, agent),
    version: new VersionService(host, agent),
    bootstrap: new BootstrapService(agent, multiplexer),
    gitSsh: new GitSshService(host),
    multiplexer,
  });
  const tty = process.stdout.isTTY === true;
  let bar: PushProgressBar | undefined;
  let onProgress: (msg: string) => void;
  if (tty) {
    intro("sandhop push");
    const ttyBar: PushProgressBar = progress({ style: "heavy", max: 6 });
    bar = ttyBar;
    ttyBar.start("Teleporting your session…");
    onProgress = (msg: string): void => {
      if (msg === "ready") return;
      ttyBar.advance(1, formatPushProgress(msg));
    };
  } else {
    onProgress = (msg: string): void => console.error(msg);
  }
  let result: Awaited<ReturnType<TeleportService["run"]>>;
  try {
    result = await service.run(args.cwd, {
      sessionId: args.session,
      transport: buildTransport({ transport }, host.env),
      excludes: args.excludes,
      includes: args.includes,
      timeoutMs: 3_600_000,
      onProgress,
    });
  } catch (error: unknown) {
    if (tty) bar!.stop("Teleport failed", 1);
    throw error;
  }
  if (tty) {
    bar!.stop("Session teleported");
    note(
      `${result.url}\n\n  user   ${result.user}\n  pass   ${result.pass}\n  kill   sandhop kill ${result.sandboxId}`,
      "Open in your browser",
    );
    outro("Skills, MCP servers & plugins are installing in the background.");
  } else {
    console.log(`SANDHOP_URL ${result.url}`);
    console.log(`SANDHOP_AUTH ${result.user}:${result.pass}`);
    console.log(`SANDHOP_ENRICHING ${result.sandboxId}`);
    console.log(
      "enrichment running in background (profile, skills, MCP servers)",
    );
  }
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
      ...args.excludes.flatMap((exclude) => ["--exclude", exclude]),
      ...(args.profile ? [] : ["--no-profile"]),
      ...(args.strict ? ["--strict"] : []),
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
  await runPush(runtimeArgs, host);
  process.exit(0);
};

const formatCliError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof CredentialError)
    return `${message}\nRun \`sandhop setup\` to configure a provider.`;
  return message;
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
)
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(formatCliError(error));
    process.exit(1);
  });
