import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { ADAPTERS, detectAgent } from "./adapters.js";
import { extractAuth } from "./auth.js";
import { buildManifest, type AgentId } from "./manifest.js";
import { buildBundle } from "./snapshot.js";
import { e2bClient, killSession, listSessions, teleport } from "./sandbox.js";

export interface ParsedArgs {
  cmd: "push" | "list" | "kill";
  agent?: AgentId;
  session?: string;
  killId?: string;
  cwd: string;
}

const flag = (argv: string[], name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
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
    cwd,
  };
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

const runPush = async (args: ParsedArgs): Promise<void> => {
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

  const manifest = buildManifest({
    agent,
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
  const bundle = await buildBundle({
    cwd: args.cwd,
    transcriptPath: ref.transcriptPath,
    manifest,
    outDir,
  });

  const { url } = await teleport(e2bClient, {
    bundle: bundle.bundle,
    transcript: bundle.transcript,
    manifest,
    adapter: ADAPTERS[agent],
    auth,
    timeoutMs: 3_600_000,
  });
  console.log(`KEEPON_URL ${url}`);
  console.log(`Session teleported. Open: ${url}`);
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
  await runPush(args);
};

main(process.argv.slice(2)).catch((e) => {
  console.error(String(e instanceof Error ? e.message : e));
  process.exit(1);
});
