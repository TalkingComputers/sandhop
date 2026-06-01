import { buildManifest } from "../manifest.js";
import type { Agent, AuthBundle, SessionRef } from "../ports/agent.js";
import type { HostDeps } from "../ports/host.js";
import type { SandboxProvider } from "../ports/provider.js";
import type { BootstrapService } from "./bootstrap.js";

export interface TailscaleOption {
  authKey: string;
}

export interface TeleportResult {
  url: string;
  sandboxId: string;
  user: string;
  pass: string;
}

export interface TeleportOptions {
  sessionId?: string;
  profile: boolean;
  tailscale?: TailscaleOption;
  timeoutMs: number;
  onProgress?: (msg: string) => void;
}

export interface TeleportServices {
  host: Pick<HostDeps, "readBytes">;
  snapshot: { build(cwd: string, outPath: string): Promise<string> };
  session: {
    latest(cwd: string): SessionRef | Promise<SessionRef>;
    byId(cwd: string, sessionId: string): SessionRef | Promise<SessionRef>;
  };
  profile: { build(outPath: string): Promise<string | null> };
  secrets: {
    collect(
      cwd: string,
    ): Record<string, string> | Promise<Record<string, string>>;
  };
  auth: { extract(): AuthBundle | Promise<AuthBundle> };
  version: { detect(): string | Promise<string> };
  bootstrap: BootstrapService;
}

const alphabet =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const randomPassword = (): string => {
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => alphabet[byte & 63]!).join("");
};

const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", "'\\''")}'`;

const expandHome = (path: string): string =>
  path.replace(/^\$HOME/, "/home/user");

const makePath = (name: string): string => `/tmp/keepon-${Date.now()}-${name}`;

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
    const bundlePath = makePath("bundle.tgz");
    const profilePath = makePath("profile.tgz");
    opts.onProgress?.("snapshotting");
    const [bundle, session, profile, secrets, auth, cliVersion] =
      await Promise.all([
        this.services.snapshot.build(cwd, bundlePath),
        opts.sessionId === undefined
          ? this.services.session.latest(cwd)
          : this.services.session.byId(cwd, opts.sessionId),
        opts.profile
          ? this.services.profile.build(profilePath)
          : Promise.resolve(null),
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
    const envs = opts.tailscale
      ? { ...secrets, ...auth.envs, TS_AUTHKEY: opts.tailscale.authKey }
      : { ...secrets, ...auth.envs };
    opts.onProgress?.("creating sandbox");
    const sandbox = await this.provider.create({
      image: "base",
      envs,
      timeoutMs: opts.timeoutMs,
    });
    opts.onProgress?.("uploading bundle");
    await sandbox.uploadFile(
      "/tmp/bundle.tgz",
      this.services.host.readBytes(bundle),
    );
    await sandbox.uploadFile(
      "/tmp/transcript.jsonl",
      this.services.host.readBytes(session.transcriptPath),
    );
    if (profile !== null) {
      opts.onProgress?.("uploading profile");
      await sandbox.uploadFile(
        "/tmp/profile.tgz",
        this.services.host.readBytes(profile),
      );
    }
    for (const file of auth.files)
      await sandbox.uploadFile(expandHome(file.path), file.content);
    opts.onProgress?.(
      `installing ${this.agent.pkg}@${manifest.cliVersion} + ttyd`,
    );
    const restore = await sandbox.exec(
      this.services.bootstrap.render(
        manifest,
        opts.tailscale
          ? {
              hasProfile: profile !== null,
              tailscale: { sandboxId: sandbox.id },
            }
          : { hasProfile: profile !== null },
      ),
    );
    if (restore.exitCode !== 0 || !restore.stdout.includes("KEEPON_RESTORE_OK"))
      throw new Error(`Restore failed: ${restore.stderr}`);
    opts.onProgress?.("restoring session");
    const resume = this.agent.resumeCmd(session.sessionId, manifest.remoteProj);
    await sandbox.spawn(
      opts.tailscale
        ? `ttyd -i 127.0.0.1 -p 7681 -W -c ${user}:${pass} bash -lc ${shellQuote(resume)}`
        : `ttyd -p 7681 -W -c ${user}:${pass} bash -lc ${shellQuote(resume)}`,
    );
    if (opts.tailscale) {
      const ready = await sandbox.exec(
        "bash -lc 'for i in {1..60}; do (echo >/dev/tcp/127.0.0.1/7681) >/dev/null 2>&1 && exit 0; sleep 0.5; done; echo ttyd not ready >&2; exit 1'",
      );
      if (ready.exitCode !== 0)
        throw new Error(`ttyd readiness failed: ${ready.stderr}`);
      const tailscaleHostname = `keepon-${sandbox.id}.`;
      const script = `const fs=require("fs");const hostname=${JSON.stringify(tailscaleHostname)};const status=JSON.parse(fs.readFileSync(0,"utf8"));const dnsName=status.Self.DNSName;if(!dnsName.startsWith(hostname))throw new Error("unexpected DNSName "+dnsName);process.stdout.write(dnsName.slice(hostname.length).replace(/\\.$/,""))`;
      const status = await sandbox.exec(
        `tailscale status --json | node -e ${JSON.stringify(script)}`,
      );
      if (status.exitCode !== 0)
        throw new Error(`Tailscale status failed: ${status.stderr}`);
      const suffix = status.stdout.trim();
      if (!suffix)
        throw new Error("Tailscale status returned an empty MagicDNS suffix");
      opts.onProgress?.("ready");
      return {
        url: `http://keepon-${sandbox.id}.${suffix}:7681`,
        sandboxId: sandbox.id,
        user,
        pass,
      };
    }
    const exposed = await sandbox.exposePort(7681);
    opts.onProgress?.("ready");
    return { url: exposed.url, sandboxId: sandbox.id, user, pass };
  }
}
