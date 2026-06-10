import type {
  Transport,
  TransportContext,
  TransportResult,
} from "../core/ports/transport.js";

export class PublicTransport implements Transport {
  readonly id = "public" as const;

  bindAddress(): string {
    return "0.0.0.0";
  }

  bootstrapSteps(): string[] {
    return [];
  }

  async expose(ctx: TransportContext): Promise<TransportResult> {
    const exposed = await ctx.sandbox.exposePort(ctx.service.port);
    return { url: exposed.url };
  }
}
