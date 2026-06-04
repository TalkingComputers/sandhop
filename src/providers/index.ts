import type { HostDeps } from "../core/ports/host.js";
import type { SandboxProvider } from "../core/ports/provider.js";
import { DaytonaSandboxProvider } from "./daytona/index.js";
import { E2bSandboxProvider } from "./e2b/index.js";
import { ModalSandboxProvider } from "./modal/index.js";
import { VercelSandboxProvider } from "./vercel/index.js";

export type ProviderId = "e2b" | "modal" | "daytona" | "vercel";

export const PROVIDER_IDS: ProviderId[] = ["e2b", "modal", "daytona", "vercel"];

export const buildProvider = (
  id: ProviderId,
  host: HostDeps,
): SandboxProvider => {
  if (id === "e2b") return new E2bSandboxProvider(host);
  if (id === "modal") return new ModalSandboxProvider(host);
  if (id === "daytona") return new DaytonaSandboxProvider(host);
  if (id === "vercel") return new VercelSandboxProvider(host);
  throw new Error(`Unknown provider ${id}`);
};
