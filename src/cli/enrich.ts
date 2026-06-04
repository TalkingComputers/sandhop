import { pathToFileURL } from "node:url";
import { pickAgent } from "../agents/index.js";
import type { HostDeps } from "../core/ports/host.js";
import type { Sandbox } from "../core/ports/provider.js";
import type { EnrichmentStepResult } from "../core/services/bootstrap.js";
import { EnrichmentService } from "../core/services/enrichment.js";
import { buildProvider } from "../providers/index.js";
import { parseEnrichArgs, type EnrichArgs } from "./args.js";
import { buildHost } from "./host.js";

interface EnrichRunResult {
  strict: boolean;
  steps: EnrichmentStepResult[];
}

const hasFailedStep = (steps: EnrichmentStepResult[]): boolean =>
  steps.some((step) => !step.ok);

const isStrict = (strict: boolean): boolean =>
  strict || process.env["KEEPON_STRICT"] === "1";

export const enrichSandbox = async (
  args: EnrichArgs,
  host: HostDeps,
  sandbox: Sandbox,
): Promise<EnrichmentStepResult[]> =>
  new EnrichmentService(host, pickAgent(args.agent), sandbox).run(
    args.cwd,
    args.profile,
  );

export const runEnrich = async (argv: string[]): Promise<EnrichRunResult> => {
  const args = parseEnrichArgs(argv);
  const host = buildHost();
  const sandbox = await buildProvider(args.provider, host).connect(
    args.sandboxId,
  );
  return {
    strict: args.strict,
    steps: await enrichSandbox(args, host, sandbox),
  };
};

export const runEnrichCli = async (argv: string[]): Promise<number> => {
  try {
    const result = await runEnrich(argv);
    return isStrict(result.strict) && hasFailedStep(result.steps) ? 1 : 0;
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  runEnrichCli(process.argv.slice(2)).then((code) => process.exit(code));
