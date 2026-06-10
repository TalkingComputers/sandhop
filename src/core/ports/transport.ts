import type { ReadyService, Sandbox } from "./provider.js";

export interface TransportContext {
  sandbox: Sandbox;
  service: ReadyService;
}

export interface TransportResult {
  url: string;
}

export interface Transport {
  readonly id: string;
  bindAddress(): string;
  bootstrapSteps(): string[];
  expose(ctx: TransportContext): Promise<TransportResult>;
}
