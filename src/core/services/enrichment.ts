import { formatErrorStack } from "../errors.js";
import { makeTempPath } from "../paths.js";
import type { Agent } from "../ports/agent.js";
import {
  EnrichmentStepId,
  type EnrichmentProgressListener,
} from "../ports/progress.js";
import type { RunResult, Sandbox } from "../ports/provider.js";
import { execShellAsUser } from "../sandbox-runtime.js";
import {
  renderEnrichmentCompletion,
  renderEnrichmentConfig,
  renderEnrichmentInstalls,
  renderEnrichmentSetup,
  renderReinstall,
  renderSettingsScriptInstalls,
  uploadEnrichmentScripts,
  type EnrichmentStepResult,
} from "./enrichment-scripts.js";
import type { CodePlan, McpCodeService } from "./mcp-code.js";
import { uploadOwnedFiles } from "./sandbox-files.js";
import type { ExcludedServer } from "./mcp-classify.js";
import type { ProfileService } from "./profile.js";
import type { ReinstallService } from "./reinstall.js";
import type { ScriptCapturePlan, ScriptCaptureService } from "./scripts.js";
import type { TransferService } from "./transfer.js";
import { quote } from "shell-quote";

const ENRICHMENT_EXEC_TIMEOUT_MS = 1_800_000;
const ENRICHMENT_LOG = "/tmp/sandhop-enrich.log";

export interface EnrichmentReport {
  steps: EnrichmentStepResult[];
  mcpExcluded: ExcludedServer[];
}

const appendLog = async (sandbox: Sandbox, text: string): Promise<void> => {
  await execShellAsUser(
    sandbox,
    `printf '%s\\n' ${quote([text])} >> ${quote([ENRICHMENT_LOG])}`,
  );
};

const runLogged = async (
  sandbox: Sandbox,
  script: string,
  opts?: { timeoutMs?: number },
): Promise<RunResult> =>
  execShellAsUser(
    sandbox,
    [
      "set -o pipefail",
      "{",
      script,
      `} 2>&1 | tee -a ${quote([ENRICHMENT_LOG])}`,
    ].join("\n"),
    opts,
  );

const formatRunOutput = (result: RunResult): string =>
  [result.stderr, result.stdout]
    .filter((text) => text.length > 0)
    .join("\n")
    .trimEnd();

const runLoggedOrThrow = async (
  sandbox: Sandbox,
  label: string,
  script: string,
  opts?: { timeoutMs?: number },
): Promise<void> => {
  const result = await runLogged(sandbox, script, opts);
  if (result.exitCode === 0) return;
  const output = formatRunOutput(result);
  throw new Error(
    output.length === 0
      ? `${label} failed with exit code ${result.exitCode}`
      : `${label} failed with exit code ${result.exitCode}:\n${output}`,
  );
};

const recordStep = async <T>(
  steps: EnrichmentStepResult[],
  step: EnrichmentStepId,
  run: () => Promise<T>,
  onEvent?: EnrichmentProgressListener,
): Promise<T | null> => {
  onEvent?.({ kind: "enrichStep", step, status: "start" });
  try {
    const value = await run();
    steps.push({ step, ok: true });
    onEvent?.({ kind: "enrichStep", step, status: "ok" });
    return value;
  } catch (error: unknown) {
    steps.push({ step, ok: false, error: formatErrorStack(error) });
    onEvent?.({ kind: "enrichStep", step, status: "fail" });
    return null;
  }
};

const recordScriptStep = async (
  sandbox: Sandbox,
  steps: EnrichmentStepResult[],
  step: EnrichmentStepId,
  script: string,
  opts?: { timeoutMs?: number },
  onEvent?: EnrichmentProgressListener,
): Promise<void> => {
  await recordStep(
    steps,
    step,
    () => runLoggedOrThrow(sandbox, step, script, opts),
    onEvent,
  );
};

const skipStep = (
  steps: EnrichmentStepResult[],
  step: EnrichmentStepId,
  error: string,
  onEvent?: EnrichmentProgressListener,
): void => {
  onEvent?.({ kind: "enrichStep", step, status: "start" });
  steps.push({ step, ok: false, error });
  onEvent?.({ kind: "enrichStep", step, status: "fail" });
};

const EMPTY_SCRIPT_PLAN: ScriptCapturePlan = {
  mappings: [],
  rewrites: [],
  installCmds: [],
};

const STEP_ORDER = Object.values(EnrichmentStepId);

const sortSteps = (steps: EnrichmentStepResult[]): void => {
  steps.sort((a, b) => STEP_ORDER.indexOf(a.step) - STEP_ORDER.indexOf(b.step));
};

export class EnrichmentService {
  readonly agent: Agent;
  readonly services: EnrichmentServices;
  readonly excludes: string[];

  constructor(agent: Agent, services: EnrichmentServices, excludes: string[]) {
    this.agent = agent;
    this.services = services;
    this.excludes = excludes;
  }

  private get sandbox(): Sandbox {
    return this.services.sandbox;
  }

  async run(
    cwd: string,
    profile: boolean,
    onEvent?: EnrichmentProgressListener,
  ): Promise<EnrichmentReport> {
    const steps: EnrichmentStepResult[] = [];
    await appendLog(
      this.sandbox,
      `sandhop enrichment started ${new Date().toISOString()}`,
    ).catch(() => undefined);
    await recordScriptStep(
      this.sandbox,
      steps,
      EnrichmentStepId.Setup,
      renderEnrichmentSetup(),
      undefined,
      onEvent,
    );
    const captured: { codePlan: CodePlan | null } = { codePlan: null };
    await Promise.all([
      recordStep(
        steps,
        EnrichmentStepId.ProfileTransfer,
        async (): Promise<void> => {
          if (!profile) return;
          await this.sendProfile(onEvent);
        },
        onEvent,
      ),
      (async (): Promise<void> => {
        const scriptPlan =
          (await recordStep(
            steps,
            EnrichmentStepId.SettingsScriptsTransfer,
            () => this.sendScripts(cwd, onEvent),
            onEvent,
          )) ?? EMPTY_SCRIPT_PLAN;
        await recordScriptStep(
          this.sandbox,
          steps,
          EnrichmentStepId.SettingsScriptDependencyInstalls,
          renderSettingsScriptInstalls(scriptPlan),
          { timeoutMs: ENRICHMENT_EXEC_TIMEOUT_MS },
          onEvent,
        );
      })(),
      (async (): Promise<void> => {
        captured.codePlan = await recordStep(
          steps,
          EnrichmentStepId.McpCodeTransfer,
          () => this.sendMcpCode(cwd, onEvent),
          onEvent,
        );
        if (captured.codePlan === null)
          skipStep(
            steps,
            EnrichmentStepId.McpDependencyInstalls,
            "MCP code transfer failed; dependency installs skipped",
            onEvent,
          );
        else
          await recordScriptStep(
            this.sandbox,
            steps,
            EnrichmentStepId.McpDependencyInstalls,
            renderEnrichmentInstalls(captured.codePlan),
            { timeoutMs: ENRICHMENT_EXEC_TIMEOUT_MS },
            onEvent,
          );
      })(),
      recordStep(
        steps,
        EnrichmentStepId.PluginGitSkillReinstall,
        () => this.reinstallPlugins(onEvent),
        onEvent,
      ),
    ]);
    sortSteps(steps);
    await runLogged(this.sandbox, renderEnrichmentCompletion(steps)).catch(
      async (error: unknown): Promise<void> => {
        await appendLog(this.sandbox, formatErrorStack(error)).catch(
          () => undefined,
        );
      },
    );
    return { steps, mcpExcluded: captured.codePlan?.excluded ?? [] };
  }

  private async sendProfile(
    onEvent?: EnrichmentProgressListener,
  ): Promise<void> {
    const profileTree = await this.services.profile.build(
      makeTempPath("profile"),
      this.excludes,
    );
    if (profileTree !== null)
      await this.services.transfer.send(
        profileTree,
        this.sandbox.home,
        "profile",
        {
          onProgress: (transfer) => onEvent?.({ kind: "transfer", transfer }),
        },
      );
  }

  private async sendScripts(
    cwd: string,
    onEvent?: EnrichmentProgressListener,
  ): Promise<ScriptCapturePlan> {
    if (!this.agent.supportsSettingsScripts()) return EMPTY_SCRIPT_PLAN;
    const scriptPlan = this.services.scripts.plan(cwd, this.sandbox.home);
    if (scriptPlan.mappings.length === 0 && scriptPlan.rewrites.length === 0)
      return scriptPlan;
    await Promise.all(
      scriptPlan.mappings.map((mapping, index) =>
        this.services.transfer.send(
          mapping.localPath,
          mapping.sandboxPath,
          `settings-scripts-${index}`,
          {
            excludes: this.excludes,
            onProgress: (transfer) => onEvent?.({ kind: "transfer", transfer }),
          },
        ),
      ),
    );
    await uploadOwnedFiles(
      this.sandbox,
      scriptPlan.rewrites.map((rewrite) => ({
        path: rewrite.sandboxPath,
        content: rewrite.content,
      })),
      [],
    );
    return scriptPlan;
  }

  private async sendMcpCode(
    cwd: string,
    onEvent?: EnrichmentProgressListener,
  ): Promise<CodePlan> {
    const codePlan = this.services.mcpCode.plan(cwd, this.sandbox.home);
    await Promise.all(
      codePlan.mappings.map((mapping, index) =>
        this.services.transfer.send(
          mapping.localPath,
          mapping.sandboxPath,
          `mcp-${index}`,
          {
            onProgress: (transfer) => onEvent?.({ kind: "transfer", transfer }),
          },
        ),
      ),
    );
    await uploadEnrichmentScripts(
      this.sandbox,
      this.agent,
      codePlan,
      this.sandbox.home,
    );
    const result = await runLogged(
      this.sandbox,
      renderEnrichmentConfig(this.agent, codePlan, this.sandbox.home),
    );
    if (result.exitCode !== 0)
      throw new Error(`MCP config rewrite failed: ${result.stderr}`);
    return codePlan;
  }

  private async reinstallPlugins(
    onEvent?: EnrichmentProgressListener,
  ): Promise<void> {
    const plan = this.services.reinstall.plan(this.sandbox.home);
    await Promise.all(
      plan.mappings.map((mapping, index) =>
        this.services.transfer.send(
          mapping.localPath,
          mapping.sandboxPath,
          `marketplace-${index}`,
          {
            excludes: this.excludes,
            onProgress: (transfer) => onEvent?.({ kind: "transfer", transfer }),
          },
        ),
      ),
    );
    await runLoggedOrThrow(
      this.sandbox,
      "Reinstall",
      renderReinstall(plan.commands),
      { timeoutMs: ENRICHMENT_EXEC_TIMEOUT_MS },
    );
  }
}

export interface EnrichmentServices {
  sandbox: Sandbox;
  transfer: TransferService;
  profile: ProfileService;
  mcpCode: McpCodeService;
  reinstall: ReinstallService;
  scripts: ScriptCaptureService;
}
