import type { Sandbox } from "./provider.js";

export interface TransportContext {
  sandbox: Sandbox;
  localPort: number;
}

export interface TransportResult {
  url: string;
}

export interface Transport {
  readonly id: "public" | "cloudflared";
  ttydBindAddress(): string;
  bootstrapSteps(): string[];
  expose(ctx: TransportContext): Promise<TransportResult>;
}
