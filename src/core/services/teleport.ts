import { buildManifest, type Manifest } from "../manifest.js";
import { TTYD_PORT } from "../constants.js";
import { dirname, expandHome, remotePath } from "../paths.js";
import type { Agent, AuthBundle, SessionRef } from "../ports/agent.js";
import type { HostDeps } from "../ports/host.js";
import type { Multiplexer } from "../ports/multiplexer.js";
import {
  PushProgressId,
  type PushProgressListener,
  type TransferProgress,
} from "../ports/progress.js";
import {
  execShell,
  type CommandInvocation,
  type Sandbox,
  type SandboxProvider,
} from "../ports/provider.js";
import type { Transport } from "../ports/transport.js";
import { randomToken } from "../rand.js";
import { execShellAsUser } from "../sandbox-runtime.js";
import { renderRestoreScript } from "./bootstrap.js";
import type { SshBundle, SshCollector } from "./git-ssh.js";
import { mapHomePath } from "./mcp-paths.js";
import { renderPathPrep, uploadOwnedFiles } from "./sandbox-files.js";
import {
  buildTerminalFrontendHtml,
  TERMINAL_HTML_PATH,
} from "./terminal-frontend.js";
import {
  buildTerminalProxyScript,
  TERMINAL_PROXY_PATH,
} from "./terminal-proxy.js";
import { quote } from "shell-quote";
import type { SecretsBundle, SecretsCollector } from "./secrets.js";
import { TransferService } from "./transfer.js";

export interface TeleportResult {
  url: string;
  sandboxId: string;
  sandbox: Sandbox;
  user: string;
  pass: string;
  sshHosts: string[];
}

export interface TeleportOptions {
  transport: Transport;
  excludes: string[];
  includes: string[];
  timeoutMs: number;
  onProgress?: PushProgressListener;
  onTransfer?: (transfer: TransferProgress) => void;
  onSkipped?: (label: string, paths: string[]) => void;
  beforeTerminalStart?: (sandbox: Sandbox) => Promise<void>;
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
    | "readFile"
    | "realpath"
    | "remove"
    | "splitFile"
    | "statMtimeMs"
    | "tarZstd"
    | "username"
    | "walk"
  >;
  session: SessionRef;
  secrets: SecretsCollector;
  auth: () => AuthBundle;
  version: () => string;
  gitSsh: SshCollector;
  multiplexer: Multiplexer;
}

const TTYD_SESSION = "sandhop";
const TERMINAL_LOG = remotePath("/tmp/sandhop-terminal.log");
const TERMINAL_READY_TIMEOUT_MS = 10000;
const TERMINAL_READY_INTERVAL_MS = 100;
const TTYD_UPSTREAM_PORT = 7682;

const buildTerminalCommand = (
  user: string,
  pass: string,
  command: CommandInvocation,
): string =>
  [
    quote([
      "ttyd",
      "-i",
      "127.0.0.1",
      "-p",
      String(TTYD_UPSTREAM_PORT),
      "-W",
      "-t",
      "disableLeaveAlert=true",
      "-t",
      "disableResizeOverlay=true",
      "-c",
      `${user}:${pass}`,
      command.file,
      ...command.args,
    ]),
    "&",
    `exec node ${TERMINAL_PROXY_PATH}`,
  ].join(" ");

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
    opts.onProgress?.({ step: PushProgressId.Snapshotting });
    const bundle = this.services.host.realpath(cwd);
    const session = this.services.session;
    const baseSecrets = this.services.secrets.collect(cwd);
    const auth = this.services.auth();
    const cliVersion = this.services.version();
    const sshBundle = this.services.gitSsh.collect(cwd);
    const manifest = buildManifest({
      agent: this.agent.id,
      cliVersion,
      cwd,
      sessionId: session.sessionId,
      transcriptName: session.transcriptName,
      ts: Date.now(),
    });
    const transcript = this.agent.prepareTranscript(
      this.services.host,
      this.services.host.readBytes(session.transcriptPath),
    );
    const envs = { ...baseSecrets.envs, ...auth.envs };
    opts.onProgress?.({ step: PushProgressId.CreatingSandbox });
    const sandbox = await this.provider.create({
      envs,
      timeoutMs: opts.timeoutMs,
      ports: [TTYD_PORT],
      runtime: {
        home: this.services.host.home,
        username: this.services.host.username,
        workdir: cwd,
      },
      agentInstall: this.agent.installCmd(manifest.cliVersion),
    });
    try {
      opts.onProgress?.({ step: PushProgressId.UploadingBundle });
      await Promise.all([
        this.uploadWorkspace(sandbox, bundle, manifest, opts),
        (async (): Promise<void> => {
          await this.uploadCredentials(
            sandbox,
            transcript,
            baseSecrets,
            auth,
            sshBundle,
          );
          opts.onProgress?.({
            step: PushProgressId.InstallingRuntime,
            packageName: this.agent.pkg,
            version: manifest.cliVersion,
          });
          await this.restoreRuntime(sandbox, manifest, opts.transport);
        })(),
      ]);
      await opts.beforeTerminalStart?.(sandbox);
      opts.onProgress?.({ step: PushProgressId.RestoringSession });
      const url = await this.startTerminal(
        sandbox,
        this.agent.canResume(transcript) ? session.sessionId : null,
        manifest,
        opts,
        user,
        pass,
      );
      opts.onProgress?.({ step: PushProgressId.Ready });
      return {
        url,
        sandboxId: sandbox.id,
        sandbox,
        user,
        pass,
        sshHosts: sshBundle.hosts,
      };
    } catch (error: unknown) {
      try {
        await sandbox.destroy();
      } catch (destroyError: unknown) {
        throw new AggregateError(
          [error, destroyError],
          "Teleport failed and sandbox destroy failed",
        );
      }
      throw error;
    }
  }

  private async uploadWorkspace(
    sandbox: Sandbox,
    bundle: string,
    manifest: Manifest,
    opts: TeleportOptions,
  ): Promise<void> {
    const host = this.services.host;
    await execShell(sandbox, renderPathPrep(manifest.remoteProj));
    const transfer = new TransferService(host, sandbox);
    await transfer.send(bundle, manifest.remoteProj, "bundle", {
      excludes: opts.excludes,
      onProgress: opts.onTransfer,
      onSkipped: (paths) => opts.onSkipped?.("workspace", paths),
    });
    const memRel = this.agent.projectMemoryPath(manifest.remoteEnc);
    if (memRel !== null && host.exists(`${host.home}/${memRel}`))
      await transfer.send(
        `${host.home}/${memRel}`,
        `${sandbox.home}/${memRel}`,
        "memory",
        {
          excludes: opts.excludes,
          onSkipped: (paths) => opts.onSkipped?.("memory", paths),
        },
      );
    await Promise.all(
      opts.includes.map(async (include, index): Promise<void> => {
        if (!host.exists(include)) return;
        const realInclude = host.realpath(include);
        const dest = mapHomePath(
          host.home,
          sandbox.home,
          realInclude,
          "passthrough",
        );
        const destDir = host.isDirectory(realInclude) ? dest : dirname(dest);
        await execShell(sandbox, renderPathPrep(destDir));
        await transfer.send(realInclude, dest, `include-${index}`, {
          excludes: opts.excludes,
          onSkipped: (paths) => opts.onSkipped?.(realInclude, paths),
        });
      }),
    );
  }

  private async uploadCredentials(
    sandbox: Sandbox,
    transcript: Uint8Array,
    baseSecrets: SecretsBundle,
    auth: AuthBundle,
    sshBundle: SshBundle,
  ): Promise<void> {
    await sandbox.uploadFile(remotePath("/tmp/transcript.jsonl"), transcript);
    await uploadOwnedFiles(
      sandbox,
      [...baseSecrets.files, ...auth.files, ...sshBundle.files].map((file) => ({
        ...file,
        path: expandHome(file.path, sandbox.home),
      })),
      sshBundle.dirs.map((dir) => ({
        ...dir,
        path: expandHome(dir.path, sandbox.home),
      })),
    );
  }

  private async restoreRuntime(
    sandbox: Sandbox,
    manifest: Manifest,
    transport: Transport,
  ): Promise<void> {
    const preSeedScripts = this.agent.preSeed(
      this.services.host,
      manifest.remoteProj,
    );
    await uploadOwnedFiles(sandbox, [...preSeedScripts], []);
    const restore = await execShellAsUser(
      sandbox,
      renderRestoreScript(this.agent, this.services.multiplexer, manifest, {
        home: sandbox.home,
        preSeedScripts,
        transportSteps: transport.bootstrapSteps(),
        gitUserName: readGitConfig(this.services.host, "user.name"),
        gitUserEmail: readGitConfig(this.services.host, "user.email"),
      }),
    );
    if (
      restore.exitCode !== 0 ||
      !restore.stdout.includes("SANDHOP_RESTORE_OK")
    )
      throw new Error(`Restore failed: ${restore.stderr || restore.stdout}`);
  }

  private async startTerminal(
    sandbox: Sandbox,
    sessionId: string | null,
    manifest: Manifest,
    opts: TeleportOptions,
    user: string,
    pass: string,
  ): Promise<string> {
    const resume = this.agent.resumeCmd(
      sessionId,
      manifest.remoteProj,
      this.services.host.env.MCP_TIMEOUT,
    );
    const command = this.services.multiplexer.attach(TTYD_SESSION, {
      file: "bash",
      args: ["-lc", resume],
    });
    await uploadOwnedFiles(
      sandbox,
      [
        {
          path: remotePath(TERMINAL_PROXY_PATH),
          content: buildTerminalProxyScript(
            user,
            pass,
            opts.transport.bindAddress(),
            TTYD_PORT,
            TTYD_UPSTREAM_PORT,
            TERMINAL_HTML_PATH,
            TTYD_SESSION,
          ),
        },
        {
          path: remotePath(TERMINAL_HTML_PATH),
          content: buildTerminalFrontendHtml(),
        },
      ],
      [],
    );
    const service = await sandbox.startService({
      file: "bash",
      args: ["-lc", buildTerminalCommand(user, pass, command)],
      port: TTYD_PORT,
      readiness: {
        kind: "http",
        url: `http://127.0.0.1:${TTYD_PORT}`,
        status: 401,
        timeoutMs: TERMINAL_READY_TIMEOUT_MS,
        intervalMs: TERMINAL_READY_INTERVAL_MS,
      },
      stdoutPath: TERMINAL_LOG,
      stderrPath: TERMINAL_LOG,
      appendOutput: true,
    });
    const { url } = await opts.transport.expose({ sandbox, service });
    return url;
  }
}
