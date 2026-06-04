import type { HostDeps } from "../core/ports/host.js";
import type { SandboxProvider } from "../core/ports/provider.js";
import { CredentialError } from "../core/errors.js";
import { DaytonaSandboxProvider } from "./daytona/index.js";
import { E2bSandboxProvider } from "./e2b/index.js";
import { ModalSandboxProvider } from "./modal/index.js";
import { VercelSandboxProvider } from "./vercel/index.js";

export type ProviderId = "e2b" | "modal" | "daytona" | "vercel";

export const PROVIDER_IDS: ProviderId[] = ["e2b", "modal", "daytona", "vercel"];

export interface CredField {
  env: string;
  label: string;
  secret: boolean;
  required: boolean;
}

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  docsUrl: string;
  credentials: CredField[];
}

export const PROVIDER_INFO: Record<ProviderId, ProviderInfo> = {
  e2b: {
    id: "e2b",
    label: "E2B",
    docsUrl: "https://e2b.dev/dashboard?tab=keys",
    credentials: [
      {
        env: "E2B_API_KEY",
        label: "E2B API key",
        secret: true,
        required: true,
      },
    ],
  },
  modal: {
    id: "modal",
    label: "Modal",
    docsUrl: "https://modal.com/settings/tokens",
    credentials: [
      {
        env: "MODAL_TOKEN_ID",
        label: "Modal token id",
        secret: false,
        required: true,
      },
      {
        env: "MODAL_TOKEN_SECRET",
        label: "Modal token secret",
        secret: true,
        required: true,
      },
    ],
  },
  daytona: {
    id: "daytona",
    label: "Daytona",
    docsUrl: "https://app.daytona.io/dashboard/keys",
    credentials: [
      {
        env: "DAYTONA_API_KEY",
        label: "Daytona API key",
        secret: true,
        required: true,
      },
      {
        env: "DAYTONA_API_URL",
        label: "Daytona API URL (optional)",
        secret: false,
        required: false,
      },
      {
        env: "DAYTONA_TARGET",
        label: "Daytona target region (optional)",
        secret: false,
        required: false,
      },
    ],
  },
  vercel: {
    id: "vercel",
    label: "Vercel Sandbox",
    docsUrl: "https://vercel.com/account/tokens",
    credentials: [
      {
        env: "VERCEL_TOKEN",
        label: "Vercel token",
        secret: true,
        required: true,
      },
      {
        env: "VERCEL_TEAM_ID",
        label: "Vercel team id (team_...)",
        secret: false,
        required: true,
      },
      {
        env: "VERCEL_PROJECT_ID",
        label: "Vercel project id (prj_...)",
        secret: false,
        required: true,
      },
    ],
  },
};

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

const readCredField = (id: ProviderId, env: string): CredField => {
  const field = PROVIDER_INFO[id].credentials.find(
    (credential) => credential.env === env,
  );
  if (field === undefined)
    throw new CredentialError(`${env} is not declared for ${id}`);
  return field;
};

export const requireCred = (
  host: Pick<HostDeps, "env">,
  id: ProviderId,
  env: string,
): string => {
  const field = readCredField(id, env);
  const value = host.env[field.env];
  if (value === undefined || value === "")
    throw new CredentialError(
      `${field.env} is required — set it or run \`keepon setup\``,
    );
  return value;
};

export const optionalCred = (
  host: Pick<HostDeps, "env">,
  id: ProviderId,
  env: string,
): string | undefined => {
  const field = readCredField(id, env);
  const value = host.env[field.env];
  return value === "" ? undefined : value;
};
