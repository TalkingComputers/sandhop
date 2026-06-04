import { buildManifest } from "../manifest.js";
import { makeTempPath, sandboxExpandHome } from "../paths.js";
import type { Agent } from "../ports/agent.js";
import type { HostDeps } from "../ports/host.js";
import type { SandboxProvider } from "../ports/provider.js";
import type { Transport } from "../ports/transport.js";
import { shellQuote } from "../shell.js";
import type { AuthExtractor } from "./auth.js";
import type { BootstrapService } from "./bootstrap.js";
import type { SecretsCollector } from "./secrets.js";
import type { SessionReader } from "./session.js";
import type { SnapshotBuilder } from "./snapshot.js";
import { makeTarGzipCommand } from "./transfer.js";
import type { VersionDetector } from "./version.js";

export interface TeleportResult {
  url: string;
  sandboxId: string;
  user: string;
  pass: string;
}

export interface TeleportOptions {
  sessionId?: string;
  profile: boolean;
  transport: Transport;
  timeoutMs: number;
  onProgress?: (msg: string) => void;
}

export interface TeleportServices {
  host: Pick<HostDeps, "readBytes" | "spawnPipe">;
  snapshot: SnapshotBuilder;
  session: SessionReader;
  secrets: SecretsCollector;
  auth: AuthExtractor;
  version: VersionDetector;
  bootstrap: BootstrapService;
}

const alphabet =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const randomPassword = (): string => {
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => alphabet[byte & 63]!).join("");
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
    const user = "keepon";
    const pass = randomPassword();
    opts.onProgress?.("snapshotting");
    const [bundle, session, baseSecrets, auth, cliVersion] = await Promise.all([
      this.services.snapshot.build(cwd),
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
      originalCwd: cwd,
      sessionId: session.sessionId,
      transcriptName: session.transcriptName,
      ts: Date.now(),
    });
    const envs = { ...baseSecrets.envs, ...auth.envs };
    opts.onProgress?.("creating sandbox");
    const sandbox = await this.provider.create({
      envs,
      timeoutMs: opts.timeoutMs,
      ports: [7681],
    });
    opts.onProgress?.("uploading bundle");
    const bundlePath = makeTempPath("bundle.tgz");
    await this.services.host.spawnPipe(makeTarGzipCommand(bundlePath, bundle));
    await sandbox.uploadFile(
      "/tmp/bundle.tgz",
      this.services.host.readBytes(bundlePath),
    );
    await sandbox.uploadFile(
      "/tmp/transcript.jsonl",
      this.services.host.readBytes(session.transcriptPath),
    );
    for (const file of baseSecrets.files)
      await sandbox.uploadFile(sandboxExpandHome(file.path), file.content);
    for (const file of auth.files)
      await sandbox.uploadFile(sandboxExpandHome(file.path), file.content);
    opts.onProgress?.(
      `installing ${this.agent.pkg}@${manifest.cliVersion} + ttyd`,
    );
    const restore = await sandbox.exec(
      this.services.bootstrap.render(manifest, {
        transportSteps: opts.transport.bootstrapSteps(),
      }),
    );
    if (restore.exitCode !== 0 || !restore.stdout.includes("KEEPON_RESTORE_OK"))
      throw new Error(`Restore failed: ${restore.stderr}`);
    opts.onProgress?.("restoring session");
    const resume = this.agent.resumeCmd(session.sessionId, manifest.remoteProj);
    const bind = opts.transport.ttydBindAddress();
    const bindFlag = bind === "0.0.0.0" ? "" : `-i ${bind} `;
    await sandbox.spawn(
      `ttyd ${bindFlag}-p 7681 -W -c ${user}:${pass} bash -lc ${shellQuote(resume)}`,
    );
    const { url } = await opts.transport.expose({
      sandbox,
      localPort: 7681,
      user,
      pass,
    });
    opts.onProgress?.("ready");
    return { url, sandboxId: sandbox.id, user, pass };
  }
}
