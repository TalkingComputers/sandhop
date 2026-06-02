import { pathToFileURL } from "node:url";
import { pickAgent } from "../agents/index.js";
import { safeRemoteProj } from "../core/encode.js";
import type { AgentId } from "../core/ports/agent.js";
import type { HostDeps } from "../core/ports/host.js";
import type { RunResult, Sandbox } from "../core/ports/provider.js";
import {
  BootstrapService,
  type EnrichmentStepResult,
} from "../core/services/bootstrap.js";
import type { CodePlan } from "../core/services/mcp-code.js";
import { McpCodeService } from "../core/services/mcp-code.js";
import { ProfileService } from "../core/services/profile.js";
import { ReinstallService } from "../core/services/reinstall.js";
import { SecretsService } from "../core/services/secrets.js";
import {
  LOCAL_PATH_EXCLUDES,
  ScriptCaptureService,
  type ScriptCapturePlan,
} from "../core/services/scripts.js";
import { TransferService } from "../core/services/transfer.js";
import { NodeHost } from "../host/node.js";
import { E2bSandboxProvider } from "../providers/e2b/index.js";

export interface EnrichArgs {
  sandboxId: string;
  agent: AgentId;
  cwd: string;
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
  profile: !argv.includes("--no-profile"),
});

const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", "'\\''")}'`;

const shellLog = (value: string): string =>
  value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("$", "\\$")
    .replaceAll("`", "\\`");

const LOW_PRIORITY_SETUP =
  'KEEPON_LOW_PRIORITY="nice -n 19"; if command -v ionice >/dev/null 2>&1; then KEEPON_LOW_PRIORITY="nice -n 19 ionice -c3"; fi';

const expandHome = (path: string): string =>
  path.replace(/^\$HOME/, "/home/user");

const makePath = (name: string): string => `/tmp/keepon-${Date.now()}-${name}`;

const appendLog = async (sandbox: Sandbox, text: string): Promise<void> => {
  const marker = `KEEPON_ENRICH_LOG_${Date.now()}`;
  await sandbox.exec(
    `cat >> /tmp/keepon-enrich.log <<'${marker}'\n${text}\n${marker}`,
  );
};

const errorText = (error: unknown): string =>
  error instanceof Error ? (error.stack ?? error.message) : String(error);

const runLogged = async (
  sandbox: Sandbox,
  script: string,
): Promise<RunResult> =>
  sandbox.exec(["{", script, "} >> /tmp/keepon-enrich.log 2>&1"].join("\n"));

const renderReinstall = (commands: string[]): string => {
  if (commands.length === 0) return 'echo "[keepon] reinstall skipped"';
  return [
    LOW_PRIORITY_SETUP,
    "export CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1",
    ...commands.map(
      (command) =>
        `$KEEPON_LOW_PRIORITY sh -lc ${shellQuote(command)} || { echo "[keepon] reinstall step failed: ${shellLog(command)}" >&2; true; }`,
    ),
  ].join("\n");
};

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
    const text = errorText(error);
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

export const enrichSandbox = async (
  args: EnrichArgs,
  host: HostDeps,
  sandbox: Sandbox,
): Promise<void> => {
  const agent = pickAgent(args.agent);
  try {
    await appendLog(
      sandbox,
      `keepon enrichment started ${new Date().toISOString()}`,
    ).catch(() => undefined);
    const transfer = new TransferService(host, sandbox);
    const profile = new ProfileService(host, agent);
    const mcpCode = new McpCodeService(host, agent);
    const reinstall = new ReinstallService(host, agent);
    const secrets = new SecretsService(host, agent);
    const scripts = new ScriptCaptureService(host);
    const bootstrap = new BootstrapService(agent);
    const steps: EnrichmentStepResult[] = [];
    await recordScriptStep(
      sandbox,
      steps,
      "enrichment setup",
      bootstrap.renderEnrichmentSetup(),
    );
    await recordStep(
      sandbox,
      steps,
      "profile transfer + extract",
      async (): Promise<void> => {
        if (!args.profile) return;
        const profileTree = await profile.build(makePath("profile"));
        if (profileTree !== null)
          await transfer.send(profileTree, "/home/user", "profile", {
            codec: "zstd",
            lowPriority: true,
          });
      },
    );
    await recordScriptStep(
      sandbox,
      steps,
      "re-apply preseed (trust + root config)",
      agent.preSeed(safeRemoteProj(args.cwd).dir).join("\n"),
    );
    let codePlan: CodePlan | null = null;
    let scriptPlan: ScriptCapturePlan | null = null;
    await recordStep(
      sandbox,
      steps,
      "settings scripts transfer + rewrite",
      async (): Promise<void> => {
        if (agent.id !== "claude-code") return;
        scriptPlan = scripts.plan(args.cwd);
        if (
          scriptPlan.mappings.length === 0 &&
          scriptPlan.rewrites.length === 0
        )
          return;
        await Promise.all(
          scriptPlan.mappings.map((mapping, index) =>
            transfer.send(
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
          await sandbox.uploadFile(rewrite.sandboxPath, rewrite.content);
      },
    );
    await recordScriptStep(
      sandbox,
      steps,
      "settings script dependency installs",
      bootstrap.renderSettingsScriptInstalls(scriptPlan),
    );
    await recordStep(
      sandbox,
      steps,
      "mcp code transfer + config rewrite",
      async (): Promise<void> => {
        codePlan = await mcpCode.build(args.cwd);
        if (codePlan === null) return;
        await Promise.all(
          codePlan.mappings.map((mapping, index) =>
            transfer.send(
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
        const bundle = secrets.collect(args.cwd, {
          envRefs: codePlan.envRefs,
          referencedFiles: codePlan.referencedFiles,
        });
        for (const file of bundle.files)
          await sandbox.uploadFile(expandHome(file.path), file.content);
        const result = await runLogged(
          sandbox,
          bootstrap.renderEnrichmentConfig(safeRemoteProj(args.cwd).dir, {
            codePlan,
          }),
        );
        if (result.exitCode !== 0)
          throw new Error(`MCP config rewrite failed: ${result.stderr}`);
      },
    );
    await recordScriptStep(
      sandbox,
      steps,
      "per-MCP dependency installs",
      bootstrap.renderEnrichmentInstalls({ codePlan }),
    );
    await recordScriptStep(
      sandbox,
      steps,
      "plugin and git skill reinstall",
      renderReinstall(reinstall.plan().commands),
    );
    await runLogged(sandbox, bootstrap.renderEnrichmentCompletion(steps)).catch(
      async (error: unknown): Promise<void> => {
        await appendLog(sandbox, errorText(error)).catch(() => undefined);
      },
    );
  } catch (error: unknown) {
    await appendLog(sandbox, errorText(error)).catch(() => undefined);
  }
};

export const runEnrich = async (argv: string[]): Promise<void> => {
  const args = parseEnrichArgs(argv);
  const home = process.env.HOME;
  if (home === undefined) throw new Error("HOME is required");
  const host = new NodeHost(process.env, home);
  const sandbox = await new E2bSandboxProvider(host).connect(args.sandboxId);
  await enrichSandbox(args, host, sandbox);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  runEnrich(process.argv.slice(2)).then(
    () => process.exit(0),
    () => process.exit(0),
  );
