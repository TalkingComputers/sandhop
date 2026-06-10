import type { HostDeps } from "../core/ports/host.js";
import type { SandboxProvider } from "../core/ports/provider.js";
import { CredentialError } from "../core/errors.js";

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

export type ResolvedCredentials = Record<string, string>;

const readCredValue = (value: string | undefined): string | undefined =>
  value === undefined || value === "" ? undefined : value;

export const resolveCredentials = (
  id: ProviderId,
  env: Record<string, string | undefined>,
  stored: Record<string, string> | undefined,
): ResolvedCredentials => {
  const credentials: ResolvedCredentials = {};
  for (const field of PROVIDER_INFO[id].credentials) {
    const value =
      readCredValue(env[field.env]) ?? readCredValue(stored?.[field.env]);
    if (value !== undefined) {
      credentials[field.env] = value;
      continue;
    }
    if (field.required)
      throw new CredentialError(
        `${field.env} is required — set it or run \`sandhop setup\``,
      );
  }
  return credentials;
};

export const requireCred = (
  credentials: ResolvedCredentials,
  env: string,
): string => {
  const value = credentials[env];
  if (value === undefined)
    throw new CredentialError(
      `${env} is required — set it or run \`sandhop setup\``,
    );
  return value;
};

type ProviderLoader = (
  host: HostDeps,
  credentials: ResolvedCredentials,
) => Promise<SandboxProvider>;

const PROVIDER_LOADERS: Record<ProviderId, ProviderLoader> = {
  e2b: async (host, credentials) =>
    new (await import("./e2b/index.js")).E2bSandboxProvider(host, credentials),
  modal: async (host, credentials) =>
    new (await import("./modal/index.js")).ModalSandboxProvider(credentials),
  daytona: async (host, credentials) =>
    new (await import("./daytona/index.js")).DaytonaSandboxProvider(
      credentials,
    ),
  vercel: async (host, credentials) =>
    new (await import("./vercel/index.js")).VercelSandboxProvider(
      host,
      credentials,
    ),
};

export const buildProvider = (
  id: ProviderId,
  host: HostDeps,
  credentials: ResolvedCredentials,
): Promise<SandboxProvider> => PROVIDER_LOADERS[id](host, credentials);
