import type { AgentId } from "../core/ports/agent.js";
import type { TailscaleOption } from "../core/services/teleport.js";

export interface ParsedArgs {
  cmd: "push" | "list" | "kill";
  agent?: AgentId;
  session?: string;
  killId?: string;
  cwd: string;
  tailscale: boolean;
  profile: boolean;
}

const readFlag = (argv: string[], name: string): string | undefined => {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value) throw new Error(`${name} requires a value`);
  return value;
};

const readAgent = (value: string | undefined): AgentId | undefined => {
  if (value === undefined) return undefined;
  if (value === "claude-code" || value === "codex") return value;
  throw new Error(`Unknown agent ${value}`);
};

export const parseArgs = (argv: string[], cwd: string): ParsedArgs => {
  const cmd = argv[0] === "list" || argv[0] === "kill" ? argv[0] : "push";
  return {
    cmd,
    agent: readAgent(readFlag(argv, "--agent")),
    session: readFlag(argv, "--session"),
    killId: cmd === "kill" ? argv[1] : undefined,
    cwd: readFlag(argv, "--cwd") ?? cwd,
    tailscale: argv.includes("--tailscale"),
    profile: !argv.includes("--no-profile"),
  };
};

export const readTailscaleOption = (
  args: ParsedArgs,
  env: Record<string, string | undefined>,
): TailscaleOption | undefined => {
  if (!args.tailscale) return undefined;
  const authKey = env.TS_AUTHKEY;
  if (authKey === undefined)
    throw new Error("TS_AUTHKEY is required when --tailscale is set");
  return { authKey };
};
