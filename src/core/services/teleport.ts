import { buildManifest } from "../manifest.js";
import { TTYD_PORT } from "../constants.js";
import { dirname, expandHome } from "../paths.js";
import type { Agent, AuthBundle } from "../ports/agent.js";
import type { HostDeps } from "../ports/host.js";
import type { Multiplexer } from "../ports/multiplexer.js";
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
    | "exec"
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
  multiplexer: Multiplexer;
}

const TTYD_SESSION = "sandhop";

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

const chmodAuthFiles = async (
  sandbox: Sandbox,
  files: AuthBundle["files"],
): Promise<void> => {
  for (const file of files) {
    if (file.mode === undefined) continue;
    await sandbox.exec(
      `chmod ${shellQuote(file.mode)} ${shellQuote(expandHome(file.path, sandbox.home))}`,
    );
  }
};

const readGitConfig = (
  host: Pick<HostDeps, "exec">,
  key: string,
): string | undefined => {
  try {
    const value = host.exec("git", ["config", "--global", "--get", key]).trim();
    return value.length === 0 ? undefined : value;
  } catch {
    return undefined;
  }
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
      const mem = this.agent.projectMemoryDir(
        this.services.host.home,
        manifest.remoteEnc,
      );
      if (mem !== null && this.services.host.exists(mem))
        await transfer.send(
          mem,
          expandHome(
            `$HOME/.claude/projects/${manifest.remoteEnc}/memory`,
            sandbox.home,
          ),
          "memory",
          { codec: "gzip", excludes: opts.excludes },
        );
      for (const [index, include] of opts.includes.entries()) {
        if (!this.services.host.exists(include)) continue;
        const realInclude = this.services.host.realpath(include);
        const dest = mirrorPath(
          realInclude,
          this.services.host.home,
          sandbox.home,
        );
        const destDir = this.services.host.isDirectory(realInclude)
          ? dest
          : dirname(dest);
        await sandbox.exec(this.services.bootstrap.renderPathPrep(destDir));
        await transfer.send(realInclude, dest, `include-${index}`, {
          codec: "gzip",
          excludes: opts.excludes,
        });
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
      await chmodAuthFiles(sandbox, auth.files);
      await chmodSshBundle(sandbox, sshBundle);
      opts.onProgress?.(
        `installing ${this.agent.pkg}@${manifest.cliVersion} + ttyd`,
      );
      const restore = await sandbox.exec(
        this.services.bootstrap.render(manifest, {
          home: sandbox.home,
          transportSteps: opts.transport.bootstrapSteps(),
          gitUserName: readGitConfig(this.services.host, "user.name"),
          gitUserEmail: readGitConfig(this.services.host, "user.email"),
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
      const command = this.services.multiplexer.attach(
        TTYD_SESSION,
        `bash -lc ${shellQuote(resume)}`,
      );
      await sandbox.spawn(
        `ttyd ${bindFlag}-p ${TTYD_PORT} -W -c ${shellQuote(`${user}:${pass}`)} ${command}`,
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
