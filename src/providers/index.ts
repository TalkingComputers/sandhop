import type { HostDeps } from "../core/ports/host.js";
import type { SandboxProvider } from "../core/ports/provider.js";
import { DaytonaSandboxProvider } from "./daytona/index.js";
import { E2bSandboxProvider } from "./e2b/index.js";
import { ModalSandboxProvider } from "./modal/index.js";

export type ProviderId = "e2b" | "modal" | "daytona";

export const PROVIDER_IDS: ProviderId[] = ["e2b", "modal", "daytona"];

export const buildProvider = (
  id: ProviderId,
  host: HostDeps,
): SandboxProvider => {
  if (id === "e2b") return new E2bSandboxProvider(host);
  if (id === "modal") return new ModalSandboxProvider(host);
  if (id === "daytona") return new DaytonaSandboxProvider(host);
  throw new Error(`Unknown provider ${id}`);
};
