import { randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { Sandbox } from "e2b";
import type { Adapter } from "./adapters.js";
import type { AuthBundle } from "./auth.js";
import { renderBootstrap } from "./bootstrap.js";
import type { Manifest } from "./manifest.js";

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SandboxClient {
  create(
    template: string,
    envs: Record<string, string>,
    timeoutMs: number,
  ): Promise<string>;
  writeFile(id: string, path: string, data: Uint8Array | string): Promise<void>;
  run(id: string, cmd: string, background: boolean): Promise<RunResult | void>;
  host(id: string, port: number): Promise<string>;
}

const expandHome = (p: string): string => p.replace(/^\$HOME/, "/home/user");

const instances = new Map<string, Sandbox>();

const getSandbox = async (id: string): Promise<Sandbox> => {
  const sandbox = instances.get(id);
  if (sandbox) return sandbox;
  const connected = await Sandbox.connect(id);
  instances.set(id, connected);
  return connected;
};

export const teleport = async (
  client: SandboxClient,
  opts: {
    bundle: string;
    transcript: string;
    manifest: Manifest;
    adapter: Adapter;
    auth: AuthBundle;
    timeoutMs: number;
    onProgress?: (msg: string) => void;
  },
): Promise<{ url: string; sandboxId: string; user: string; pass: string }> => {
  const user = "keepon";
  const pass = randomBytes(18).toString("base64url");
  opts.onProgress?.("creating sandbox");
  const id = await client.create("base", opts.auth.envs, opts.timeoutMs);
  opts.onProgress?.(
    `uploading bundle (${(statSync(opts.bundle).size / 1024 / 1024).toFixed(2)} MB)`,
  );
  await client.writeFile(
    id,
    "/tmp/bundle.tgz",
    new Uint8Array(readFileSync(opts.bundle)),
  );
  await client.writeFile(
    id,
    "/tmp/transcript.jsonl",
    new Uint8Array(readFileSync(opts.transcript)),
  );
  for (const f of opts.auth.files)
    await client.writeFile(id, expandHome(f.path), f.content);

  opts.onProgress?.(
    `installing ${opts.adapter.pkg}@${opts.manifest.cliVersion} + ttyd`,
  );
  const restore = (await client.run(
    id,
    renderBootstrap(opts.manifest, opts.adapter),
    false,
  )) as RunResult;
  if (!restore.stdout.includes("KEEPON_RESTORE_OK"))
    throw new Error(`Restore failed: ${restore.stderr}`);

  opts.onProgress?.("restoring session");
  const resume = opts.adapter.resumeCmd(
    opts.manifest.sessionId,
    opts.manifest.remoteProj,
  );
  await client.run(
    id,
    `ttyd -p 7681 -W -c ${user}:${pass} bash -lc '${resume}'`,
    true,
  );
  const url = `https://${await client.host(id, 7681)}`;
  opts.onProgress?.("ready");
  return { url, sandboxId: id, user, pass };
};

export const e2bClient: SandboxClient = {
  create: async (template, envs, timeoutMs) => {
    const sandbox = await Sandbox.create(template, {
      envs,
      timeoutMs,
    });
    instances.set(sandbox.sandboxId, sandbox);
    return sandbox.sandboxId;
  },
  writeFile: async (id, path, data) => {
    const sbx = await getSandbox(id);
    const body = typeof data === "string" ? data : new Uint8Array(data).buffer;
    await sbx.files.write(path, body, {
      requestTimeoutMs: 600000,
      useOctetStream: true,
    });
  },
  run: async (id, cmd, background) => {
    const sbx = await getSandbox(id);
    if (background) {
      await sbx.commands.run(cmd, { background: true, timeoutMs: 0 });
      return;
    }
    const r = await sbx.commands.run(cmd, {
      timeoutMs: 600000,
      requestTimeoutMs: 600000,
    });
    return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
  },
  host: async (id, port) => (await getSandbox(id)).getHost(port),
};

export const listSessions = async (): Promise<
  { sandboxId: string; startedAt: Date }[]
> => {
  const out: { sandboxId: string; startedAt: Date }[] = [];
  const paginator = Sandbox.list();
  while (paginator.hasNext) {
    for (const s of await paginator.nextItems())
      out.push({ sandboxId: s.sandboxId, startedAt: s.startedAt });
  }
  return out;
};

export const killSession = async (id: string): Promise<boolean> =>
  Sandbox.kill(id);
