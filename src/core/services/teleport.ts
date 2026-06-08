import { buildManifest } from "../manifest.js";
import { TTYD_PORT } from "../constants.js";
import { dirname, expandHome } from "../paths.js";
import type { Agent } from "../ports/agent.js";
import type { HostDeps } from "../ports/host.js";
import type { Multiplexer } from "../ports/multiplexer.js";
import {
  PushProgressId,
  type PushProgressListener,
} from "../ports/progress.js";
import type { Sandbox, SandboxProvider } from "../ports/provider.js";
import type { Transport } from "../ports/transport.js";
import { randomToken } from "../rand.js";
import { shellQuote } from "../shell.js";
import type { AuthExtractor } from "./auth.js";
import type { BootstrapService } from "./bootstrap.js";
import type { SshBundle, SshCollector } from "./git-ssh.js";
import { mapHomePath } from "./mcp-paths.js";
import type { SecretsCollector } from "./secrets.js";
import type { SessionReader } from "./session.js";
import { TransferService } from "./transfer.js";
import type { VersionDetector } from "./version.js";

export interface TeleportResult {
  url: string;
  sandboxId: string;
  sandbox: Sandbox;
  user: string;
  pass: string;
}

export interface TeleportOptions {
  sessionId?: string;
  transport: Transport;
  excludes: string[];
  includes: string[];
  timeoutMs: number;
  onProgress?: PushProgressListener;
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
const TERMINAL_LOG = "/tmp/sandhop-terminal.log";
const CLAUDE_SANDHOP_COMMAND = "<command-name>/sandhop</command-name>";
const USER_TRANSCRIPT_LINE = '"type":"user"';

const prepareTranscriptUpload = (
  agent: Agent,
  bytes: Uint8Array,
): Uint8Array => {
  if (agent.id !== "claude-code") return bytes;
  const text = new TextDecoder().decode(bytes);
  const lines = text.split("\n");
  let end = text.length;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!;
    const start = end - line.length;
    if (
      line.includes(USER_TRANSCRIPT_LINE) &&
      line.includes(CLAUDE_SANDHOP_COMMAND)
    )
      return new TextEncoder().encode(text.slice(0, start));
    end = start - 1;
  }
  return bytes;
};

const buildTerminalCommand = (
  bind: string,
  user: string,
  pass: string,
  command: string,
): string => {
  const bindFlag = bind === "0.0.0.0" ? "" : `-i ${shellQuote(bind)} `;
  return `ttyd ${bindFlag}-p ${TTYD_PORT} -W -c ${shellQuote(`${user}:${pass}`)} ${command} >> ${TERMINAL_LOG} 2>&1`;
};

const verifyTerminalReady = async (sandbox: Sandbox): Promise<void> => {
  const result = await sandbox.exec(
    [
      "i=0",
      'while [ "$i" -lt 50 ]; do',
      `  if pgrep -f ${shellQuote(`ttyd .*${TTYD_PORT}`)} >/dev/null 2>&1; then exit 0; fi`,
      "  i=$((i+1))",
      "  sleep 0.1",
      "done",
      'echo "[sandhop] terminal failed to start" >&2',
      `if [ -f ${shellQuote(TERMINAL_LOG)} ]; then tail -n 80 ${shellQuote(TERMINAL_LOG)} >&2; fi`,
      "exit 1",
    ].join("\n"),
    { timeoutMs: 10000 },
  );
  if (result.exitCode !== 0)
    throw new Error(
      `Terminal failed to start: ${result.stderr.length > 0 ? result.stderr : result.stdout}`,
    );
};

const uploadModeFiles = async (
  bootstrap: BootstrapService,
  sandbox: Sandbox,
  files: { path: string; content: string; mode?: string }[],
): Promise<void> => {
  for (const file of files) {
    const dest = expandHome(file.path, sandbox.home);
    await bootstrap.prepAndUpload(sandbox, dest, file.content);
    if (file.mode !== undefined)
      await sandbox.exec(`chmod ${shellQuote(file.mode)} ${shellQuote(dest)}`);
  }
};

const uploadSshBundle = async (
  bootstrap: BootstrapService,
  sandbox: Sandbox,
  bundle: SshBundle,
): Promise<void> => {
  if (bundle.files.length === 0) return;
  await uploadModeFiles(bootstrap, sandbox, bundle.files);
  const dirs = bundle.dirs.map((dir) =>
    shellQuote(expandHome(dir, sandbox.home)),
  );
  if (dirs.length > 0) await sandbox.exec(`chmod 700 ${dirs.join(" ")}`);
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
    opts.onProgress?.({ step: PushProgressId.Snapshotting });
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
    });
    try {
      opts.onProgress?.({ step: PushProgressId.UploadingBundle });
      await sandbox.exec(this.services.bootstrap.renderProjectPrep(manifest));
      const transfer = new TransferService(this.services.host, sandbox);
      await transfer.send(bundle, manifest.remoteProj, "bundle", {
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
          { excludes: opts.excludes },
        );
      for (const [index, include] of opts.includes.entries()) {
        if (!this.services.host.exists(include)) continue;
        const realInclude = this.services.host.realpath(include);
        const dest = mapHomePath(
          this.services.host.home,
          sandbox.home,
          realInclude,
          "passthrough",
        );
        const destDir = this.services.host.isDirectory(realInclude)
          ? dest
          : dirname(dest);
        await sandbox.exec(this.services.bootstrap.renderPathPrep(destDir));
        await transfer.send(realInclude, dest, `include-${index}`, {
          excludes: opts.excludes,
        });
      }
      await sandbox.uploadFile(
        "/tmp/transcript.jsonl",
        prepareTranscriptUpload(
          this.agent,
          this.services.host.readBytes(session.transcriptPath),
        ),
      );
      await uploadModeFiles(this.services.bootstrap, sandbox, [
        ...baseSecrets.files.map((file) => ({ ...file })),
        ...auth.files,
      ]);
      await uploadSshBundle(this.services.bootstrap, sandbox, sshBundle);
      opts.onProgress?.({
        step: PushProgressId.InstallingRuntime,
        packageName: this.agent.pkg,
        version: manifest.cliVersion,
      });
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
      opts.onProgress?.({ step: PushProgressId.RestoringSession });
      const resume = this.agent.resumeCmd(
        session.sessionId,
        manifest.remoteProj,
        this.services.host.env.MCP_TIMEOUT,
      );
      const bind = opts.transport.ttydBindAddress();
      const command = this.services.multiplexer.attach(
        TTYD_SESSION,
        `bash -lc ${shellQuote(resume)}`,
      );
      await sandbox.spawn(buildTerminalCommand(bind, user, pass, command));
      await verifyTerminalReady(sandbox);
      const { url } = await opts.transport.expose({
        sandbox,
        localPort: TTYD_PORT,
      });
      opts.onProgress?.({ step: PushProgressId.Ready });
      return { url, sandboxId: sandbox.id, sandbox, user, pass };
    } catch (error: unknown) {
      await sandbox.destroy().catch(() => undefined);
      throw error;
    }
  }
}
