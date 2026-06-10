import { parseArgs as parseNodeArgs } from "node:util";
import type { AgentId } from "../core/ports/agent.js";
import type { Transport } from "../core/ports/transport.js";
import type { SandhopTransport } from "./config.js";
import { PROVIDER_IDS, type ProviderId } from "../providers/index.js";
import {
  CloudflaredTransport,
  type CloudflaredOptions,
} from "../transports/cloudflared.js";
import { PublicTransport } from "../transports/public.js";

export interface ParsedArgs {
  cmd: "push" | "list" | "kill" | "setup" | "help" | "version";
  agent?: AgentId;
  session?: string;
  killId?: string;
  cwd: string;
  provider?: ProviderId;
  transport?: SandhopTransport;
  excludes: string[];
  includes: string[];
  profile: boolean;
  ssh: boolean;
}

const CLI_OPTIONS = {
  agent: { type: "string" },
  session: { type: "string" },
  cwd: { type: "string" },
  provider: { type: "string" },
  tunnel: { type: "string" },
  exclude: { type: "string", multiple: true },
  include: { type: "string", multiple: true },
  profile: { type: "boolean" },
  ssh: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
} as const;

const COMMANDS = new Set<ParsedArgs["cmd"]>(["push", "list", "kill", "setup"]);

export const readAgent = (value: string | undefined): AgentId | undefined => {
  if (value === undefined) return undefined;
  if (value === "claude-code" || value === "codex") return value;
  throw new Error(`Unknown agent ${value}`);
};

export const readTransport = (value: string | undefined): SandhopTransport => {
  if (value === undefined)
    throw new Error("pass --tunnel or run `sandhop setup`");
  if (value === "public" || value === "cloudflared") return value;
  throw new Error("--tunnel must be 'public' or 'cloudflared'");
};

const readOptionalTransport = (
  value: string | undefined,
): SandhopTransport | undefined =>
  value === undefined ? undefined : readTransport(value);

const isProviderId = (value: string): value is ProviderId =>
  PROVIDER_IDS.includes(value as ProviderId);

export const readProvider = (value: string | undefined): ProviderId => {
  if (value === undefined)
    throw new Error("pass --provider or run `sandhop setup`");
  if (isProviderId(value)) return value;
  throw new Error(`--provider must be one of: ${PROVIDER_IDS.join(", ")}`);
};

const readOptionalProvider = (
  value: string | undefined,
): ProviderId | undefined =>
  value === undefined ? undefined : readProvider(value);

const splitCsv = (values: string[] | undefined): string[] =>
  (values ?? [])
    .flatMap((value) => value.split(","))
    .filter((item) => item.length > 0);

const readCmd = (
  command: string | undefined,
  values: { help?: boolean; version?: boolean },
): ParsedArgs["cmd"] => {
  if (values.version === true) return "version";
  if (values.help === true || command === undefined || command === "help")
    return "help";
  if (COMMANDS.has(command as ParsedArgs["cmd"]))
    return command as ParsedArgs["cmd"];
  throw new Error(
    `Unknown command ${command}\nRun \`sandhop --help\` for usage.`,
  );
};

const parseTokens = (
  argv: string[],
): ReturnType<
  typeof parseNodeArgs<{
    args: string[];
    options: typeof CLI_OPTIONS;
    allowPositionals: true;
  }>
> =>
  parseNodeArgs({
    args: argv,
    options: CLI_OPTIONS,
    allowPositionals: true,
    allowNegative: true,
  });

export const parseArgs = (argv: string[], cwd: string): ParsedArgs => {
  let parsed: ReturnType<typeof parseTokens>;
  try {
    parsed = parseTokens(argv);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}\nRun \`sandhop --help\` for usage.`);
  }
  const { values, positionals } = parsed;
  const cmd = readCmd(positionals[0], values);
  return {
    cmd,
    agent: readAgent(values.agent),
    session: values.session,
    killId: cmd === "kill" ? positionals[1] : undefined,
    cwd: values.cwd ?? cwd,
    provider: readOptionalProvider(values.provider),
    transport: readOptionalTransport(values.tunnel),
    excludes: splitCsv(values.exclude),
    includes: splitCsv(values.include),
    profile: values.profile !== false,
    ssh: values.ssh !== false,
  };
};

export const buildTransport = (
  transport: SandhopTransport,
  cloudflare: CloudflaredOptions,
): Transport =>
  transport === "public"
    ? new PublicTransport()
    : new CloudflaredTransport(cloudflare);
