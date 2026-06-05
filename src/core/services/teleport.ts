import { buildManifest } from "../manifest.js";
import { TTYD_PORT } from "../constants.js";
import { expandHome } from "../paths.js";
import type { Agent } from "../ports/agent.js";
import type { HostDeps } from "../ports/host.js";
import type { Sandbox, SandboxProvider } from "../ports/provider.js";
import type { Transport } from "../ports/transport.js";
import { randomToken } from "../rand.js";
import { shellQuote } from "../shell.js";
import type { AuthExtractor } from "./auth.js";
import type { BootstrapService } from "./bootstrap.js";
import type { SshBundle, SshCollector } from "./git-ssh.js";
import type { SecretsCollector } from "./secrets.js";
import type { SessionReader } from "./session.js";
import { TransferService } from "./transfer.js";
import type { VersionDetector } from "./version.js";

export interface TeleportResult {
  url: string;
  sandboxId: string;
  user: string;
  pass: string;
}

export interface TeleportOptions {
  sessionId?: string;
  transport: Transport;
  excludes: string[];
  includes: string[];
  timeoutMs: number;
  onProgress?: (msg: string) => void;
}

export interface TeleportServices {
  host: Pick<
    HostDeps,
    | "env"
    | "exists"
    | "fileSize"
    | "home"
    | "isDirectory"
    | "cpuCount"
    | "readBytes"
    | "realpath"
    | "remove"
    | "spawnPipe"
    | "splitFile"
    | "username"
  >;
  session: SessionReader;
  secrets: SecretsCollector;
  auth: AuthExtractor;
  version: VersionDetector;
  bootstrap: BootstrapService;
  gitSsh: SshCollector;
}

const mirrorPath = (
  path: string,
  hostHome: string,
  sandboxHome: string,
): string => {
  if (path === hostHome) return sandboxHome;
  const homePrefix = `${hostHome}/`;
  if (path.startsWith(homePrefix))
    return `${sandboxHome}/${path.slice(homePrefix.length)}`;
  return path;
};

const chmodSshBundle = async (
  sandbox: Sandbox,
  bundle: SshBundle,
): Promise<void> => {
  if (bundle.files.length === 0) return;
  for (const file of bundle.files)
    await sandbox.uploadFile(expandHome(file.path, sandbox.home), file.content);
  const dirs = bundle.dirs.map((dir) =>
    shellQuote(expandHome(dir, sandbox.home)),
  );
  await sandbox.exec(
    [
      ...dirs.map((dir) => `mkdir -p ${dir}`),
      ...(dirs.length === 0 ? [] : [`chmod 700 ${dirs.join(" ")}`]),
      ...bundle.files.map(
        (file) =>
          `chmod ${shellQuote(file.mode)} ${shellQuote(expandHome(file.path, sandbox.home))}`,
      ),
    ].join("; "),
  );
};

export class TeleportService {
  readonly provider: SandboxProvider;
  readonly agent: Agent;
  readonly services: TeleportServices;

  constructor(
    provider: SandboxProvider,
    agent: Agent,
    services: TeleportServices,
  ) {
    this.provider = provider;
    this.agent = agent;
    this.services = services;
  }

  async run(cwd: string, opts: TeleportOptions): Promise<TeleportResult> {
    const user = this.services.host.username;
    const pass = randomToken(24);
    opts.onProgress?.("snapshotting");
    const [bundle, session, baseSecrets, auth, cliVersion, sshBundle] =
      await Promise.all([
        this.services.host.realpath(cwd),
        opts.sessionId === undefined
          ? this.services.session.latest(cwd)
          : this.services.session.byId(cwd, opts.sessionId),
        this.services.secrets.collect(cwd),
        this.services.auth.extract(),
        this.services.version.detect(),
        this.services.gitSsh.collect(cwd),
      ]);
    const manifest = buildManifest({
      agent: this.agent.id,
      cliVersion,
      cwd,
      sessionId: session.sessionId,
      transcriptName: session.transcriptName,
      ts: Date.now(),
    });
    const envs = { ...baseSecrets.envs, ...auth.envs };
    opts.onProgress?.("creating sandbox");
    const sandbox = await this.provider.create({
      envs,
      timeoutMs: opts.timeoutMs,
      ports: [TTYD_PORT],
    });
    try {
      opts.onProgress?.("uploading bundle");
      await sandbox.exec(this.services.bootstrap.renderProjectPrep(manifest));
      const transfer = new TransferService(this.services.host, sandbox);
      await transfer.send(bundle, manifest.remoteProj, "bundle", {
        codec: "gzip",
        excludes: opts.excludes,
      });
      for (const [index, include] of opts.includes.entries()) {
        if (!this.services.host.exists(include)) continue;
        const realInclude = this.services.host.realpath(include);
        await transfer.send(
          realInclude,
          mirrorPath(realInclude, this.services.host.home, sandbox.home),
          `include-${index}`,
          { codec: "gzip", excludes: [] },
        );
      }
      await sandbox.uploadFile(
        "/tmp/transcript.jsonl",
        this.services.host.readBytes(session.transcriptPath),
      );
      for (const file of baseSecrets.files)
        await sandbox.uploadFile(
          expandHome(file.path, sandbox.home),
          file.content,
        );
      for (const file of auth.files)
        await sandbox.uploadFile(
          expandHome(file.path, sandbox.home),
          file.content,
        );
      await chmodSshBundle(sandbox, sshBundle);
      opts.onProgress?.(
        `installing ${this.agent.pkg}@${manifest.cliVersion} + ttyd`,
      );
      const restore = await sandbox.exec(
        this.services.bootstrap.render(manifest, {
          home: sandbox.home,
          transportSteps: opts.transport.bootstrapSteps(),
        }),
      );
      if (
        restore.exitCode !== 0 ||
        !restore.stdout.includes("SANDHOP_RESTORE_OK")
      )
        throw new Error(`Restore failed: ${restore.stderr || restore.stdout}`);
      opts.onProgress?.("restoring session");
      const resume = this.agent.resumeCmd(
        session.sessionId,
        manifest.remoteProj,
        this.services.host.env.MCP_TIMEOUT,
      );
      const bind = opts.transport.ttydBindAddress();
      const bindFlag = bind === "0.0.0.0" ? "" : `-i ${shellQuote(bind)} `;
      await sandbox.spawn(
        `ttyd ${bindFlag}-p ${TTYD_PORT} -W -c ${shellQuote(`${user}:${pass}`)} bash -lc ${shellQuote(resume)}`,
      );
      const { url } = await opts.transport.expose({
        sandbox,
        localPort: TTYD_PORT,
      });
      opts.onProgress?.("ready");
      return { url, sandboxId: sandbox.id, user, pass };
    } catch (error: unknown) {
      await sandbox.destroy().catch(() => undefined);
      throw error;
    }
  }
}
