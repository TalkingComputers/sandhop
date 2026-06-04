import { formatErrorStack } from "../errors.js";
import { makeTempPath, sandboxExpandHome } from "../paths.js";
import type { Agent } from "../ports/agent.js";
import type { RunResult, Sandbox } from "../ports/provider.js";
import type { BootstrapService, EnrichmentStepResult } from "./bootstrap.js";
import type { CodePlan } from "./mcp-code.js";
import type { McpCodeService } from "./mcp-code.js";
import type { ProfileService } from "./profile.js";
import type { ReinstallService } from "./reinstall.js";
import type { SecretsService } from "./secrets.js";
import {
  LOCAL_PATH_EXCLUDES,
  type ScriptCaptureService,
  type ScriptCapturePlan,
} from "./scripts.js";
import type { TransferService } from "./transfer.js";

const appendLog = async (sandbox: Sandbox, text: string): Promise<void> => {
  const marker = `KEEPON_ENRICH_LOG_${Date.now()}`;
  await sandbox.exec(
    `cat >> /tmp/keepon-enrich.log <<'${marker}'\n${text}\n${marker}`,
  );
};

const runLogged = async (
  sandbox: Sandbox,
  script: string,
): Promise<RunResult> =>
  sandbox.exec(["{", script, "} >> /tmp/keepon-enrich.log 2>&1"].join("\n"));

const recordStep = async (
  sandbox: Sandbox,
  steps: EnrichmentStepResult[],
  name: string,
  run: () => Promise<void>,
): Promise<void> => {
  await appendLog(sandbox, `[keepon] step started: ${name}`).catch(
    () => undefined,
  );
  try {
    await run();
    steps.push({ name, ok: true });
    await appendLog(sandbox, `[keepon] step ok: ${name}`).catch(
      () => undefined,
    );
  } catch (error: unknown) {
    const text = formatErrorStack(error);
    steps.push({ name, ok: false, error: text });
    await appendLog(sandbox, `[keepon] step failed: ${name}\n${text}`).catch(
      () => undefined,
    );
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
        `keepon enrichment started ${new Date().toISOString()}`,
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
          const profileTree = await this.profile.build(makeTempPath("profile"));
          if (profileTree !== null)
            await this.transfer.send(profileTree, "/home/user", "profile", {
              codec: "zstd",
              lowPriority: true,
            });
        },
      );
      await recordScriptStep(
        this.sandbox,
        steps,
        "re-apply preseed (trust + root config)",
        this.agent.preSeed(cwd).join("\n"),
      );
      let codePlan: CodePlan | null = null;
      let scriptPlan: ScriptCapturePlan | null = null;
      await recordStep(
        this.sandbox,
        steps,
        "settings scripts transfer + rewrite",
        async (): Promise<void> => {
          if (!this.agent.supportsSettingsScripts()) return;
          scriptPlan = this.scripts.plan(cwd);
          if (
            scriptPlan.mappings.length === 0 &&
            scriptPlan.rewrites.length === 0
          )
            return;
          await Promise.all(
            scriptPlan.mappings.map((mapping, index) =>
              this.transfer.send(
                mapping.localPath,
                mapping.sandboxPath,
                `settings-scripts-${index}`,
                {
                  codec: "zstd",
                  lowPriority: true,
                  excludes: LOCAL_PATH_EXCLUDES,
                },
              ),
            ),
          );
          for (const rewrite of scriptPlan.rewrites)
            await this.sandbox.uploadFile(rewrite.sandboxPath, rewrite.content);
        },
      );
      await recordScriptStep(
        this.sandbox,
        steps,
        "settings script dependency installs",
        this.bootstrap.renderSettingsScriptInstalls(scriptPlan),
      );
      await recordStep(
        this.sandbox,
        steps,
        "mcp code transfer + config rewrite",
        async (): Promise<void> => {
          codePlan = await this.mcpCode.build(cwd);
          if (codePlan === null) return;
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
              sandboxExpandHome(file.path),
              file.content,
            );
          const result = await runLogged(
            this.sandbox,
            this.bootstrap.renderEnrichmentConfig(cwd, {
              codePlan,
            }),
          );
          if (result.exitCode !== 0)
            throw new Error(`MCP config rewrite failed: ${result.stderr}`);
        },
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
