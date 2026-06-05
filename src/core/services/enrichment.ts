import { formatErrorStack } from "../errors.js";
import { expandHome, makeTempPath } from "../paths.js";
import type { Agent } from "../ports/agent.js";
import type { RunResult, Sandbox } from "../ports/provider.js";
import type { BootstrapService, EnrichmentStepResult } from "./bootstrap.js";
import type { CodePlan } from "./mcp-code.js";
import type { McpCodeService } from "./mcp-code.js";
import type { ProfileService } from "./profile.js";
import type { ReinstallService } from "./reinstall.js";
import type { SecretsService } from "./secrets.js";
import type { ScriptCaptureService, ScriptCapturePlan } from "./scripts.js";
import type { TransferService } from "./transfer.js";

const appendLog = async (sandbox: Sandbox, text: string): Promise<void> => {
  const marker = `SANDHOP_ENRICH_LOG_${Date.now()}`;
  await sandbox.exec(
    `cat >> /tmp/sandhop-enrich.log <<'${marker}'\n${text}\n${marker}`,
  );
};

const runLogged = async (
  sandbox: Sandbox,
  script: string,
): Promise<RunResult> =>
  sandbox.exec(["{", script, "} >> /tmp/sandhop-enrich.log 2>&1"].join("\n"));

const recordStep = async <T>(
  sandbox: Sandbox,
  steps: EnrichmentStepResult[],
  name: string,
  run: () => Promise<T>,
): Promise<T | null> => {
  await appendLog(sandbox, `[sandhop] step started: ${name}`).catch(
    () => undefined,
  );
  try {
    const value = await run();
    steps.push({ name, ok: true });
    await appendLog(sandbox, `[sandhop] step ok: ${name}`).catch(
      () => undefined,
    );
    return value;
  } catch (error: unknown) {
    const text = formatErrorStack(error);
    steps.push({ name, ok: false, error: text });
    await appendLog(sandbox, `[sandhop] step failed: ${name}\n${text}`).catch(
      () => undefined,
    );
    return null;
  }
};

const recordScriptStep = async (
  sandbox: Sandbox,
  steps: EnrichmentStepResult[],
  name: string,
  script: string,
): Promise<void> => {
  await recordStep(sandbox, steps, name, async (): Promise<void> => {
    const result = await runLogged(sandbox, script);
    if (result.exitCode !== 0)
      throw new Error(`${name} failed: ${result.stderr}`);
  });
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

  constructor(agent: Agent, services: EnrichmentServices) {
    this.agent = agent;
    this.sandbox = services.sandbox;
    this.transfer = services.transfer;
    this.profile = services.profile;
    this.mcpCode = services.mcpCode;
    this.reinstall = services.reinstall;
    this.secrets = services.secrets;
    this.scripts = services.scripts;
    this.bootstrap = services.bootstrap;
  }

  async run(cwd: string, profile: boolean): Promise<EnrichmentStepResult[]> {
    const steps: EnrichmentStepResult[] = [];
    try {
      await appendLog(
        this.sandbox,
        `sandhop enrichment started ${new Date().toISOString()}`,
      ).catch(() => undefined);
      await recordScriptStep(
        this.sandbox,
        steps,
        "enrichment setup",
        this.bootstrap.renderEnrichmentSetup(),
      );
      await recordStep(
        this.sandbox,
        steps,
        "profile transfer + extract",
        async (): Promise<void> => {
          if (!profile) return;
          await this.sendProfile();
        },
      );
      await recordScriptStep(
        this.sandbox,
        steps,
        "re-apply preseed (trust + root config)",
        this.agent.preSeed(cwd).join("\n"),
      );
      const scriptPlan = await recordStep(
        this.sandbox,
        steps,
        "settings scripts transfer + rewrite",
        () => this.sendScripts(cwd),
      );
      await recordScriptStep(
        this.sandbox,
        steps,
        "settings script dependency installs",
        this.bootstrap.renderSettingsScriptInstalls(scriptPlan),
      );
      const codePlan = await recordStep(
        this.sandbox,
        steps,
        "mcp code transfer + config rewrite",
        () => this.sendMcpCode(cwd),
      );
      await recordScriptStep(
        this.sandbox,
        steps,
        "per-MCP dependency installs",
        this.bootstrap.renderEnrichmentInstalls({ codePlan }),
      );
      await recordScriptStep(
        this.sandbox,
        steps,
        "plugin and git skill reinstall",
        this.bootstrap.renderReinstall(this.reinstall.plan().commands),
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

  private async sendProfile(): Promise<void> {
    const profileTree = await this.profile.build(makeTempPath("profile"));
    if (profileTree !== null)
      await this.transfer.send(profileTree, this.sandbox.home, "profile", {
        codec: "zstd",
        lowPriority: true,
      });
  }

  private async sendScripts(cwd: string): Promise<ScriptCapturePlan> {
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
            codec: "zstd",
            lowPriority: true,
            excludes: ["node_modules", ".venv", ".git"],
          },
        ),
      ),
    );
    for (const rewrite of scriptPlan.rewrites)
      await this.sandbox.uploadFile(rewrite.sandboxPath, rewrite.content);
    return scriptPlan;
  }

  private async sendMcpCode(cwd: string): Promise<CodePlan | null> {
    const codePlan = await this.mcpCode.build(cwd, this.sandbox.home);
    if (codePlan === null) return null;
    await Promise.all(
      codePlan.mappings.map((mapping, index) =>
        this.transfer.send(
          mapping.localPath,
          mapping.sandboxPath,
          `mcp-${index}`,
          {
            codec: "zstd",
            lowPriority: true,
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
      this.bootstrap.renderEnrichmentConfig(cwd, { codePlan }),
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
