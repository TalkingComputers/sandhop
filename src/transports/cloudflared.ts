import type {
  Transport,
  TransportContext,
  TransportResult,
} from "../core/ports/transport.js";
import { remotePath } from "../core/paths.js";

export interface CloudflaredOptions {
  token?: string;
  hostname?: string;
}

const LOG_PATH = remotePath("/tmp/sandhop-cloudflared.log");
const TUNNEL_READY_TIMEOUT_MS = 60000;
const TUNNEL_READY_INTERVAL_MS = 500;
const TUNNEL_READY = /Registered tunnel connection/;
const QUICK_TUNNEL_URL = /(https:\/\/[a-z0-9-]+\.trycloudflare\.com)/;

export class CloudflaredTransport implements Transport {
  readonly id = "cloudflared" as const;
  readonly opts: CloudflaredOptions;

  constructor(opts: CloudflaredOptions) {
    this.opts = opts;
  }

  bindAddress(): string {
    return "127.0.0.1";
  }

  bootstrapSteps(): string[] {
    return ["command -v cloudflared"];
  }

  async expose(ctx: TransportContext): Promise<TransportResult> {
    if (this.opts.token !== undefined)
      return this.exposeNamed(ctx, this.opts.token);
    return this.exposeQuick(ctx);
  }

  private async exposeNamed(
    ctx: TransportContext,
    token: string,
  ): Promise<TransportResult> {
    if (this.opts.hostname === undefined)
      throw new Error(
        "CLOUDFLARE_TUNNEL_HOSTNAME is required for a named cloudflared tunnel",
      );
    await ctx.sandbox.startService({
      file: "cloudflared",
      args: [
        "tunnel",
        "--no-autoupdate",
        "--protocol",
        "http2",
        "run",
        "--token",
        token,
      ],
      port: ctx.service.port,
      readiness: {
        kind: "log",
        path: LOG_PATH,
        matches: [TUNNEL_READY],
        timeoutMs: TUNNEL_READY_TIMEOUT_MS,
        intervalMs: TUNNEL_READY_INTERVAL_MS,
      },
      stdoutPath: LOG_PATH,
      stderrPath: LOG_PATH,
      appendOutput: true,
    });
    return { url: `https://${this.opts.hostname}` };
  }

  private async exposeQuick(ctx: TransportContext): Promise<TransportResult> {
    const service = await ctx.sandbox.startService({
      file: "cloudflared",
      args: [
        "tunnel",
        "--no-autoupdate",
        "--protocol",
        "http2",
        "--url",
        `http://localhost:${ctx.service.port}`,
      ],
      port: ctx.service.port,
      readiness: {
        kind: "log",
        path: LOG_PATH,
        matches: [TUNNEL_READY, QUICK_TUNNEL_URL],
        capture: QUICK_TUNNEL_URL,
        timeoutMs: TUNNEL_READY_TIMEOUT_MS,
        intervalMs: TUNNEL_READY_INTERVAL_MS,
      },
      stdoutPath: LOG_PATH,
      stderrPath: LOG_PATH,
      appendOutput: true,
    });
    return { url: service.output };
  }
}
