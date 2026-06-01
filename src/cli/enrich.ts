import { pathToFileURL } from "node:url";
import { pickAgent } from "../agents/index.js";
import { safeRemoteProj } from "../core/encode.js";
import type { AgentId } from "../core/ports/agent.js";
import type { HostDeps } from "../core/ports/host.js";
import type { Sandbox } from "../core/ports/provider.js";
import { BootstrapService } from "../core/services/bootstrap.js";
import type { CodePlan } from "../core/services/mcp-code.js";
import { McpCodeService } from "../core/services/mcp-code.js";
import { ProfileService } from "../core/services/profile.js";
import { SecretsService } from "../core/services/secrets.js";
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

const expandHome = (path: string): string =>
  path.replace(/^\$HOME/, "/home/user");

const makePath = (name: string): string => `/tmp/keepon-${Date.now()}-${name}`;

const appendLog = async (sandbox: Sandbox, text: string): Promise<void> => {
  const marker = `KEEPON_ENRICH_LOG_${Date.now()}`;
  await sandbox.exec(
    `cat >> /tmp/keepon-enrich.log <<'${marker}'\n${text}\n${marker}`,
  );
};

const runLogged = async (sandbox: Sandbox, script: string): Promise<void> => {
  const result = await sandbox.exec(
    [
      "{",
      script,
      `echo ${shellQuote("keepon enrichment complete")}`,
      "} >> /tmp/keepon-enrich.log 2>&1",
    ].join("\n"),
  );
  if (result.exitCode !== 0)
    throw new Error(`Enrichment bootstrap failed: ${result.stderr}`);
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
    const secrets = new SecretsService(host, agent);
    const profileTask = args.profile
      ? (async (): Promise<void> => {
          const profileTree = await profile.build(makePath("profile"));
          if (profileTree !== null)
            await transfer.send(profileTree, "/home/user", "profile");
        })()
      : Promise.resolve();
    let codePlan: CodePlan | null = null;
    const codeTask = (async (): Promise<void> => {
      codePlan = await mcpCode.build(args.cwd);
      if (codePlan === null) return;
      await Promise.all(
        codePlan.mappings.map((mapping, index) =>
          transfer.send(mapping.localPath, mapping.sandboxPath, `mcp-${index}`),
        ),
      );
      const bundle = secrets.collect(args.cwd, {
        envRefs: codePlan.envRefs,
        referencedFiles: codePlan.referencedFiles,
      });
      for (const file of bundle.files)
        await sandbox.uploadFile(expandHome(file.path), file.content);
    })();
    await Promise.all([profileTask, codeTask]);
    await runLogged(
      sandbox,
      new BootstrapService(agent).renderEnrichment(
        safeRemoteProj(args.cwd).dir,
        {
          codePlan,
        },
      ),
    );
  } catch (error: unknown) {
    await appendLog(
      sandbox,
      String(error instanceof Error ? error.stack : error),
    ).catch(() => undefined);
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
