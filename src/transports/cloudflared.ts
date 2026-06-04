import type {
  Transport,
  TransportContext,
  TransportResult,
} from "../core/ports/transport.js";
import { shellQuote } from "../core/shell.js";

export interface CloudflaredOptions {
  token?: string;
  hostname?: string;
}

const LOG_PATH = "/tmp/sandhop-cloudflared.log";

export class CloudflaredTransport implements Transport {
  readonly id = "cloudflared" as const;
  readonly opts: CloudflaredOptions;

  constructor(opts: CloudflaredOptions) {
    this.opts = opts;
  }

  ttydBindAddress(): string {
    return "127.0.0.1";
  }

  bootstrapSteps(): string[] {
    return [
      "$SUDO curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${CF_ARCH} -o /usr/local/bin/cloudflared",
      "$SUDO chmod +x /usr/local/bin/cloudflared",
    ];
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
    await ctx.sandbox.spawn(
      `cloudflared tunnel --no-autoupdate --protocol http2 run --token ${shellQuote(token)} > ${LOG_PATH} 2>&1`,
    );
    const result = await ctx.sandbox.exec(
      `bash -lc 'for i in $(seq 1 120); do grep -q "Registered tunnel connection" ${LOG_PATH} && exit 0; sleep 0.5; done; echo "cloudflared did not connect" >&2; cat ${LOG_PATH} >&2; exit 1'`,
    );
    if (result.exitCode !== 0) throw new Error(result.stderr);
    return { url: `https://${this.opts.hostname}` };
  }

  private async exposeQuick(ctx: TransportContext): Promise<TransportResult> {
    await ctx.sandbox.spawn(
      `cloudflared tunnel --no-autoupdate --protocol http2 --url http://localhost:${ctx.localPort} > ${LOG_PATH} 2>&1`,
    );
    const result = await ctx.sandbox.exec(
      `bash -lc 'for i in $(seq 1 120); do u=$(grep -oE "https://[a-z0-9-]+\\.trycloudflare\\.com" ${LOG_PATH} | head -1); [ -n "$u" ] && grep -q "Registered tunnel connection" ${LOG_PATH} && { echo "$u"; exit 0; }; sleep 0.5; done; cat ${LOG_PATH} >&2; exit 1'`,
    );
    if (result.exitCode !== 0) throw new Error(result.stderr);
    const url = result.stdout.trim();
    if (url.length === 0) throw new Error("cloudflared did not return a URL");
    return { url };
  }
}
