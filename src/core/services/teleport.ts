import { buildManifest } from "../manifest.js";
import { TTYD_PORT } from "../constants.js";
import { expandHome } from "../paths.js";
import type { Agent } from "../ports/agent.js";
import type { HostDeps } from "../ports/host.js";
import type { SandboxProvider } from "../ports/provider.js";
import type { Transport } from "../ports/transport.js";
import { randomToken } from "../rand.js";
import { shellQuote } from "../shell.js";
import type { AuthExtractor } from "./auth.js";
import type { BootstrapService } from "./bootstrap.js";
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
  timeoutMs: number;
  onProgress?: (msg: string) => void;
}

export interface TeleportServices {
  host: Pick<
    HostDeps,
    | "env"
    | "exists"
    | "fileSize"
    | "isDirectory"
    | "cpuCount"
    | "readBytes"
    | "realpath"
    | "spawnPipe"
    | "splitFile"
    | "username"
  >;
  session: SessionReader;
  secrets: SecretsCollector;
  auth: AuthExtractor;
  version: VersionDetector;
  bootstrap: BootstrapService;
}

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
    const [bundle, session, baseSecrets, auth, cliVersion] = await Promise.all([
      this.services.host.realpath(cwd),
      opts.sessionId === undefined
        ? this.services.session.latest(cwd)
        : this.services.session.byId(cwd, opts.sessionId),
      this.services.secrets.collect(cwd),
      this.services.auth.extract(),
      this.services.version.detect(),
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
    opts.onProgress?.("uploading bundle");
    await sandbox.exec(this.services.bootstrap.renderProjectPrep(manifest));
    const transfer = new TransferService(this.services.host, sandbox);
    await transfer.send(bundle, manifest.remoteProj, "bundle", {
      codec: "gzip",
      excludes: [],
    });
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
    const bindFlag = bind === "0.0.0.0" ? "" : `-i ${bind} `;
    await sandbox.spawn(
      `ttyd ${bindFlag}-p ${TTYD_PORT} -W -c ${user}:${pass} bash -lc ${shellQuote(resume)}`,
    );
    const { url } = await opts.transport.expose({
      sandbox,
      localPort: TTYD_PORT,
    });
    opts.onProgress?.("ready");
    return { url, sandboxId: sandbox.id, user, pass };
  }
}
