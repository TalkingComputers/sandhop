import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { ADAPTERS, detectAgent } from "./adapters.js";
import { extractAuth } from "./auth.js";
import { buildManifest, type AgentId } from "./manifest.js";
import { buildBundle } from "./snapshot.js";
import {
  e2bClient,
  killSession,
  listSessions,
  teleport,
  type TailscaleOption,
} from "./sandbox.js";

export interface ParsedArgs {
  cmd: "push" | "list" | "kill";
  agent?: AgentId;
  session?: string;
  killId?: string;
  cwd: string;
  tailscale: boolean;
}

const flag = (argv: string[], name: string): string | undefined => {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const value = argv[i + 1];
  if (!value) throw new Error(`${name} requires a value`);
  return value;
};

export const parseArgs = (argv: string[], cwd: string): ParsedArgs => {
  const cmd = (
    argv[0] === "list" || argv[0] === "kill" ? argv[0] : "push"
  ) as ParsedArgs["cmd"];
  return {
    cmd,
    agent: flag(argv, "--agent") as AgentId | undefined,
    session: flag(argv, "--session"),
    killId: cmd === "kill" ? argv[1] : undefined,
    cwd: flag(argv, "--cwd") ?? cwd,
    tailscale: argv.includes("--tailscale"),
  };
};

export const readTailscaleOption = (
  args: ParsedArgs,
  env: Record<string, string | undefined>,
): TailscaleOption | undefined => {
  if (!args.tailscale) return undefined;
  const authKey = env.TS_AUTHKEY;
  if (!authKey)
    throw new Error("TS_AUTHKEY is required when --tailscale is set");
  return { authKey };
};

export const detectCliVersion = (agent: AgentId): string => {
  const command = agent === "claude-code" ? "claude" : "codex";
  const out = execFileSync(command, ["--version"], { encoding: "utf8" }).trim();
  const version = out.match(/(\d+\.\d+\.\d+)/)?.[1];
  if (!version)
    throw new Error(`Could not parse ${agent} version from "${out}"`);
  return version;
};

const keychain = (service: string): string | null => {
  try {
    return execFileSync(
      "security",
      ["find-generic-password", "-w", "-s", service],
      { encoding: "utf8" },
    ).trim();
  } catch {
    return null;
  }
};

const readFileSafe = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

const runPush = async (
  args: ParsedArgs,
  onProgress: (msg: string) => void,
): Promise<void> => {
  const home = process.env.HOME!;
  const agents = args.agent ? [args.agent] : detectAgent(home, args.cwd);
  if (agents.length === 0)
    throw new Error(`No Claude Code or Codex session found for ${args.cwd}`);
  const agent = agents.includes("claude-code") ? "claude-code" : agents[0]!;
  if (agents.length > 1) console.error(`Multiple agents found; using ${agent}`);

  const sessions = ADAPTERS[agent].findSessions(home, args.cwd);
  const ref = args.session
    ? sessions.find((s) => s.sessionId === args.session)
    : sessions[0];
  if (!ref)
    throw new Error(
      `No session transcript found for ${args.cwd}${args.session ? ` (id ${args.session})` : ""}`,
    );
  const sessionId = ref.sessionId;
  const transcriptName = basename(ref.transcriptPath);
  const cliVersion = detectCliVersion(agent);
  const tailscale = readTailscaleOption(args, process.env);

  const manifest = buildManifest({
    agent,
    cliVersion,
    originalCwd: args.cwd,
    sessionId,
    transcriptName,
    ts: Date.now(),
  });
  const auth = extractAuth(agent, {
    env: process.env,
    keychain,
    readFile: readFileSafe,
    home,
  });
  const outDir = mkdtempSync(join(tmpdir(), "keepon-"));
  onProgress("snapshotting");
  const bundle = await buildBundle({
    cwd: args.cwd,
    transcriptPath: ref.transcriptPath,
    manifest,
    outDir,
  });

  const { url, user, pass } = await teleport(e2bClient, {
    bundle: bundle.bundle,
    transcript: bundle.transcript,
    manifest,
    adapter: ADAPTERS[agent],
    auth,
    tailscale,
    timeoutMs: 3_600_000,
    onProgress,
  });
  console.log(`KEEPON_URL ${url}`);
  console.log(`KEEPON_AUTH ${user}:${pass}`);
};

export const main = async (argv: string[]): Promise<void> => {
  const args = parseArgs(argv, process.cwd());
  if (args.cmd === "list") {
    for (const s of await listSessions())
      console.log(`${s.sandboxId}\t${s.startedAt.toISOString()}`);
    return;
  }
  if (args.cmd === "kill") {
    if (!args.killId) throw new Error("kill requires a sandbox id");
    console.log((await killSession(args.killId)) ? "killed" : "not found");
    return;
  }
  await runPush(args, (msg) => console.error(msg));
  process.exit(0);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2)).catch((e) => {
    console.error(String(e instanceof Error ? e.message : e));
    process.exit(1);
  });
