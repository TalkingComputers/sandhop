import { formatErrorStack } from "../errors.js";
import { expandHome, makeTempPath } from "../paths.js";
import type { Agent } from "../ports/agent.js";
import {
  EnrichmentStepId,
  type EnrichmentProgressListener,
} from "../ports/progress.js";
import type { RunResult, Sandbox } from "../ports/provider.js";
import type { BootstrapService, EnrichmentStepResult } from "./bootstrap.js";
import type { CodePlan, McpCodeService } from "./mcp-code.js";
import type { ProfileService } from "./profile.js";
import type { ReinstallService } from "./reinstall.js";
import type { SecretsService } from "./secrets.js";
import type { ScriptCapturePlan, ScriptCaptureService } from "./scripts.js";
import type { TransferService } from "./transfer.js";

const ENRICHMENT_EXEC_TIMEOUT_MS = 1_800_000;

const appendLog = async (sandbox: Sandbox, text: string): Promise<void> => {
  const marker = `SANDHOP_ENRICH_LOG_${Date.now()}`;
  await sandbox.exec(
    `cat >> /tmp/sandhop-enrich.log <<'${marker}'\n${text}\n${marker}`,
  );
};

const runLogged = async (
  sandbox: Sandbox,
  script: string,
  opts?: { timeoutMs?: number },
): Promise<RunResult> =>
  sandbox.exec(
    ["{", script, "} >> /tmp/sandhop-enrich.log 2>&1"].join("\n"),
    opts,
  );

const recordStep = async <T>(
  sandbox: Sandbox,
  steps: EnrichmentStepResult[],
  step: EnrichmentStepId,
  run: () => Promise<T>,
  onEvent?: EnrichmentProgressListener,
): Promise<T | null> => {
  onEvent?.({ kind: "enrichStep", step, status: "start" });
  await appendLog(sandbox, `[sandhop] step started: ${step}`).catch(
    () => undefined,
  );
  try {
    const value = await run();
    steps.push({ step, ok: true });
    onEvent?.({ kind: "enrichStep", step, status: "ok" });
    await appendLog(sandbox, `[sandhop] step ok: ${step}`).catch(
      () => undefined,
    );
    return value;
  } catch (error: unknown) {
    const text = formatErrorStack(error);
    steps.push({ step, ok: false, error: text });
    onEvent?.({ kind: "enrichStep", step, status: "fail" });
    await appendLog(sandbox, `[sandhop] step failed: ${step}\n${text}`).catch(
      () => undefined,
    );
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
    sandbox,
    steps,
    step,
    async (): Promise<void> => {
      const result = await runLogged(sandbox, script, opts);
      if (result.exitCode !== 0)
        throw new Error(`${step} failed: ${result.stderr || result.stdout}`);
    },
    onEvent,
  );
};

export class EnrichmentService {
  readonly agent: Agent;
  readonly sandbox: Sandbox;
  readonly transfer: TransferService;
  readonly profile: ProfileService;
  readonly mcpCode: McpCodeService;
  readonly reinstall: ReinstallService;
  readonly secrets: SecretsService;
  readonly scripts: ScriptCaptureService;
  readonly bootstrap: BootstrapService;
  readonly excludes: string[];

  constructor(agent: Agent, services: EnrichmentServices, excludes: string[]) {
    this.agent = agent;
    this.sandbox = services.sandbox;
    this.transfer = services.transfer;
    this.profile = services.profile;
    this.mcpCode = services.mcpCode;
    this.reinstall = services.reinstall;
    this.secrets = services.secrets;
    this.scripts = services.scripts;
    this.bootstrap = services.bootstrap;
    this.excludes = excludes;
  }

  async run(
    cwd: string,
    profile: boolean,
    onEvent?: EnrichmentProgressListener,
  ): Promise<EnrichmentStepResult[]> {
    const steps: EnrichmentStepResult[] = [];
    try {
      await appendLog(
        this.sandbox,
        `sandhop enrichment started ${new Date().toISOString()}`,
      ).catch(() => undefined);
      await recordScriptStep(
        this.sandbox,
        steps,
        EnrichmentStepId.Setup,
        this.bootstrap.renderEnrichmentSetup(),
        undefined,
        onEvent,
      );
      await recordStep(
        this.sandbox,
        steps,
        EnrichmentStepId.ProfileTransfer,
        async (): Promise<void> => {
          if (!profile) return;
          await this.sendProfile(onEvent);
        },
        onEvent,
      );
      const scriptPlan = await recordStep(
        this.sandbox,
        steps,
        EnrichmentStepId.SettingsScriptsTransfer,
        () => this.sendScripts(cwd, onEvent),
        onEvent,
      );
      await recordScriptStep(
        this.sandbox,
        steps,
        EnrichmentStepId.SettingsScriptDependencyInstalls,
        this.bootstrap.renderSettingsScriptInstalls(scriptPlan),
        { timeoutMs: ENRICHMENT_EXEC_TIMEOUT_MS },
        onEvent,
      );
      const codePlan = await recordStep(
        this.sandbox,
        steps,
        EnrichmentStepId.McpCodeTransfer,
        () => this.sendMcpCode(cwd, onEvent),
        onEvent,
      );
      await recordScriptStep(
        this.sandbox,
        steps,
        EnrichmentStepId.McpDependencyInstalls,
        this.bootstrap.renderEnrichmentInstalls({ codePlan }),
        { timeoutMs: ENRICHMENT_EXEC_TIMEOUT_MS },
        onEvent,
      );
      await recordScriptStep(
        this.sandbox,
        steps,
        EnrichmentStepId.PluginGitSkillReinstall,
        this.bootstrap.renderReinstall(this.reinstall.plan().commands),
        { timeoutMs: ENRICHMENT_EXEC_TIMEOUT_MS },
        onEvent,
      );
      await runLogged(
        this.sandbox,
        this.bootstrap.renderEnrichmentCompletion(steps),
      ).catch(async (error: unknown): Promise<void> => {
        await appendLog(this.sandbox, formatErrorStack(error)).catch(
          () => undefined,
        );
      });
      return steps;
    } catch (error: unknown) {
      await appendLog(this.sandbox, formatErrorStack(error)).catch(
        () => undefined,
      );
      throw error;
    }
  }

  private async sendProfile(
    onEvent?: EnrichmentProgressListener,
  ): Promise<void> {
    const profileTree = await this.profile.build(
      makeTempPath("profile"),
      this.excludes,
    );
    if (profileTree !== null)
      await this.transfer.send(profileTree, this.sandbox.home, "profile", {
        onProgress: (transfer) => onEvent?.({ kind: "transfer", transfer }),
      });
  }

  private async sendScripts(
    cwd: string,
    onEvent?: EnrichmentProgressListener,
  ): Promise<ScriptCapturePlan> {
    if (!this.agent.supportsSettingsScripts())
      return { mappings: [], rewrites: [], installCmds: [] };
    const scriptPlan = this.scripts.plan(cwd, this.sandbox.home);
    if (scriptPlan.mappings.length === 0 && scriptPlan.rewrites.length === 0)
      return scriptPlan;
    await Promise.all(
      scriptPlan.mappings.map((mapping, index) =>
        this.transfer.send(
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
    for (const rewrite of scriptPlan.rewrites)
      await this.sandbox.uploadFile(rewrite.sandboxPath, rewrite.content);
    return scriptPlan;
  }

  private async sendMcpCode(
    cwd: string,
    onEvent?: EnrichmentProgressListener,
  ): Promise<CodePlan | null> {
    const codePlan = await this.mcpCode.build(
      cwd,
      this.sandbox.home,
      this.excludes,
    );
    if (codePlan === null) return null;
    await Promise.all(
      codePlan.mappings.map((mapping, index) =>
        this.transfer.send(
          mapping.localPath,
          mapping.sandboxPath,
          `mcp-${index}`,
          {
            excludes: this.excludes,
            onProgress: (transfer) => onEvent?.({ kind: "transfer", transfer }),
          },
        ),
      ),
    );
    const bundle = this.secrets.collect(cwd, {
      envRefs: codePlan.envRefs,
      referencedFiles: codePlan.referencedFiles,
    });
    for (const file of bundle.files)
      await this.sandbox.uploadFile(
        expandHome(file.path, this.sandbox.home),
        file.content,
      );
    const result = await runLogged(
      this.sandbox,
      this.bootstrap.renderEnrichmentConfig({ codePlan }),
    );
    if (result.exitCode !== 0)
      throw new Error(`MCP config rewrite failed: ${result.stderr}`);
    return codePlan;
  }
}

export interface EnrichmentServices {
  sandbox: Sandbox;
  transfer: TransferService;
  profile: ProfileService;
  mcpCode: McpCodeService;
  reinstall: ReinstallService;
  secrets: SecretsService;
  scripts: ScriptCaptureService;
  bootstrap: BootstrapService;
}
