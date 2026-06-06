import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { pickAgent } from "../agents/index.js";
import type { Agent } from "../core/ports/agent.js";
import type { HostDeps } from "../core/ports/host.js";
import type { PushListener } from "../core/ports/progress.js";
import type { Sandbox } from "../core/ports/provider.js";
import {
  BootstrapService,
  type EnrichmentStepResult,
} from "../core/services/bootstrap.js";
import {
  EnrichmentService,
  type EnrichmentServices,
} from "../core/services/enrichment.js";
import { McpCodeService } from "../core/services/mcp-code.js";
import { ProfileService } from "../core/services/profile.js";
import { ReinstallService } from "../core/services/reinstall.js";
import { SecretsService } from "../core/services/secrets.js";
import { ScriptCaptureService } from "../core/services/scripts.js";
import { TransferService } from "../core/services/transfer.js";
import { TmuxMultiplexer } from "../multiplexers/tmux.js";
import { buildProvider } from "../providers/index.js";
import { parseEnrichArgs, type EnrichArgs } from "./args.js";
import { buildHost } from "./host.js";

interface EnrichRunResult {
  strict: boolean;
  steps: EnrichmentStepResult[];
}

const hasFailedStep = (steps: EnrichmentStepResult[]): boolean =>
  steps.some((step) => !step.ok);

const isStrict = (strict: boolean): boolean => strict;

const buildEnrichmentServices = (
  host: HostDeps,
  agent: Agent,
  sandbox: Sandbox,
): EnrichmentServices => {
  const multiplexer = new TmuxMultiplexer();
  return {
    host,
    sandbox,
    transfer: new TransferService(host, sandbox),
    profile: new ProfileService(host, agent),
    mcpCode: new McpCodeService(host, agent),
    reinstall: new ReinstallService(host, agent),
    secrets: new SecretsService(host, agent),
    scripts: new ScriptCaptureService(host),
    bootstrap: new BootstrapService(agent, multiplexer),
  };
};

export const runEnrichment = async (
  args: EnrichArgs,
  host: HostDeps,
  sandbox: Sandbox,
  onEvent?: PushListener,
): Promise<EnrichmentStepResult[]> => {
  const agent = pickAgent(args.agent);
  return new EnrichmentService(
    agent,
    buildEnrichmentServices(host, agent, sandbox),
    args.excludes,
  ).run(args.cwd, args.profile, onEvent);
};

export const runEnrich = async (
  argv: string[],
  onEvent?: PushListener,
): Promise<EnrichRunResult> => {
  const args = parseEnrichArgs(argv);
  const host = buildHost();
  const sandbox = await buildProvider(args.provider, host).connect(
    args.sandboxId,
  );
  return {
    strict: args.strict,
    steps: await runEnrichment(args, host, sandbox, onEvent),
  };
};

export const runEnrichCli = async (argv: string[]): Promise<number> => {
  try {
    const args = parseEnrichArgs(argv);
    const progressFile = args.progressFile;
    const onEvent: PushListener | undefined =
      progressFile === undefined
        ? undefined
        : (event): void => {
            appendFileSync(progressFile, `${JSON.stringify(event)}\n`);
          };
    const result = await runEnrich(argv, onEvent);
    if (onEvent !== undefined)
      onEvent({
        kind: "done",
        okSteps: result.steps.filter((step) => step.ok).length,
        totalSteps: result.steps.length,
      });
    return isStrict(result.strict) && hasFailedStep(result.steps) ? 1 : 0;
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  runEnrichCli(process.argv.slice(2)).then((code) => process.exit(code));
