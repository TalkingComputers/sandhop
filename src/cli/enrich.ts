import { pathToFileURL } from "node:url";
import { pickAgent } from "../agents/index.js";
import type { AgentId } from "../core/ports/agent.js";
import type { HostDeps } from "../core/ports/host.js";
import type { Sandbox } from "../core/ports/provider.js";
import { EnrichmentService } from "../core/services/enrichment.js";
import { NodeHost } from "../host/node.js";
import { buildProvider, type ProviderId } from "../providers/index.js";
import { readProvider } from "./args.js";

export interface EnrichArgs {
  sandboxId: string;
  agent: AgentId;
  cwd: string;
  provider: ProviderId;
  profile: boolean;
}

const readFlag = (argv: string[], name: string): string => {
  const index = argv.indexOf(name);
  if (index < 0) throw new Error(`${name} is required`);
  const value = argv[index + 1];
  if (!value) throw new Error(`${name} requires a value`);
  return value;
};

const readAgent = (value: string): AgentId => {
  if (value === "claude-code" || value === "codex") return value;
  throw new Error(`Unknown agent ${value}`);
};

const parseEnrichArgs = (argv: string[]): EnrichArgs => ({
  sandboxId: readFlag(argv, "--sandbox-id"),
  agent: readAgent(readFlag(argv, "--agent")),
  cwd: readFlag(argv, "--cwd"),
  provider: readProvider(readFlag(argv, "--provider")),
  profile: !argv.includes("--no-profile"),
});

export const enrichSandbox = async (
  args: EnrichArgs,
  host: HostDeps,
  sandbox: Sandbox,
): Promise<void> => {
  await new EnrichmentService(host, pickAgent(args.agent), sandbox).run(
    args.cwd,
    args.profile,
  );
};

export const runEnrich = async (argv: string[]): Promise<void> => {
  const args = parseEnrichArgs(argv);
  const home = process.env["HOME"];
  if (home === undefined) throw new Error("HOME is required");
  const host = new NodeHost(process.env, home);
  const sandbox = await buildProvider(args.provider, host).connect(
    args.sandboxId,
  );
  await new EnrichmentService(host, pickAgent(args.agent), sandbox).run(
    args.cwd,
    args.profile,
  );
};

export const runEnrichCli = async (argv: string[]): Promise<number> => {
  try {
    await runEnrich(argv);
    return 0;
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  runEnrichCli(process.argv.slice(2)).then((code) => process.exit(code));
