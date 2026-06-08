import type { HostDeps } from "../core/ports/host.js";
import type {
  CreateOptions,
  Sandbox,
  SandboxInfo,
  SandboxProvider,
} from "../core/ports/provider.js";
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

type ProviderLoader = (host: HostDeps) => Promise<SandboxProvider>;

const PROVIDER_LOADERS: Record<ProviderId, ProviderLoader> = {
  e2b: async (host) =>
    new (await import("./e2b/index.js")).E2bSandboxProvider(host),
  modal: async (host) =>
    new (await import("./modal/index.js")).ModalSandboxProvider(host),
  daytona: async (host) =>
    new (await import("./daytona/index.js")).DaytonaSandboxProvider(host),
  vercel: async (host) =>
    new (await import("./vercel/index.js")).VercelSandboxProvider(host),
};

class LazySandboxProvider implements SandboxProvider {
  readonly name: ProviderId;
  readonly host: HostDeps;
  readonly loadProvider: ProviderLoader;
  provider: Promise<SandboxProvider> | undefined;

  constructor(name: ProviderId, host: HostDeps, loadProvider: ProviderLoader) {
    this.name = name;
    this.host = host;
    this.loadProvider = loadProvider;
  }

  getProvider(): Promise<SandboxProvider> {
    this.provider ??= this.loadProvider(this.host);
    return this.provider;
  }

  async create(opts: CreateOptions): Promise<Sandbox> {
    return (await this.getProvider()).create(opts);
  }

  async connect(id: string): Promise<Sandbox> {
    return (await this.getProvider()).connect(id);
  }

  async list(): Promise<SandboxInfo[]> {
    return (await this.getProvider()).list();
  }

  async destroy(id: string): Promise<boolean> {
    return (await this.getProvider()).destroy(id);
  }
}

export const buildProvider = (
  id: ProviderId,
  host: HostDeps,
): SandboxProvider => {
  const loader = PROVIDER_LOADERS[id];
  if (loader === undefined) throw new Error(`Unknown provider ${id}`);
  return new LazySandboxProvider(id, host, loader);
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
      `${field.env} is required — set it or run \`sandhop setup\``,
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
