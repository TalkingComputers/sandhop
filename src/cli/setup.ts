import {
  confirm,
  intro,
  isCancel,
  multiselect,
  note,
  outro,
  password,
  select,
  text,
} from "@clack/prompts";
import type { HostDeps } from "../core/ports/host.js";
import {
  PROVIDER_IDS,
  PROVIDER_INFO,
  type CredField,
  type ProviderId,
  type ProviderInfo,
} from "../providers/index.js";
import {
  loadConfig,
  saveConfig,
  type SandhopConfig,
  type SandhopTransport,
} from "./config.js";
import { installCommands } from "./install-command.js";

type SetupHost = Pick<HostDeps, "env" | "home">;

const cancelSetup = (): null => {
  outro("Cancelled");
  return null;
};

const readPrompt = <Value>(value: Value | symbol): Value | null =>
  isCancel(value) ? cancelSetup() : value;

const existingCredential = (
  host: SetupHost,
  stored: SandhopConfig | null,
  env: string,
): string | undefined => {
  const envValue = host.env[env];
  if (envValue !== undefined) return envValue;
  if (stored === null) return undefined;
  return stored.credentials[env];
};

const selectedInitialProviders = (
  host: SetupHost,
  stored: SandhopConfig | null,
): ProviderId[] => {
  const selected = PROVIDER_IDS.filter((id) =>
    PROVIDER_INFO[id].credentials.some(
      (field) => existingCredential(host, stored, field.env) !== undefined,
    ),
  );
  return selected;
};

const credentialMessage = (
  info: ProviderInfo,
  field: CredField,
  existing: string | undefined,
): string =>
  existing === undefined
    ? `${field.label} (${info.docsUrl})`
    : field.required
      ? `${field.label} (${info.docsUrl}; stored value present, leave blank to keep)`
      : `${field.label} (${info.docsUrl}; optional, clear to omit)`;

const validateRequired =
  (field: CredField, existing: string | undefined) =>
  (value: string | undefined): string | undefined => {
    if (!field.required) return undefined;
    if (value !== undefined && value.length > 0) return undefined;
    if (existing !== undefined) return undefined;
    return `${field.label} is required`;
  };

const askCredential = async (
  host: SetupHost,
  stored: SandhopConfig | null,
  info: ProviderInfo,
  field: CredField,
): Promise<string | null | undefined> => {
  const existing = existingCredential(host, stored, field.env);
  const message = credentialMessage(info, field, existing);
  const value = readPrompt(
    field.secret
      ? await password({
          message,
          mask: "*",
          validate: validateRequired(field, existing),
        })
      : await text({
          message,
          initialValue: existing,
          validate: validateRequired(field, existing),
        }),
  );
  if (value === null) return null;
  if (value !== undefined && value.length > 0) return value;
  if (field.required && existing !== undefined) return existing;
  return undefined;
};

const askCloudflareValue = async (
  label: string,
  stored: string | undefined,
  secret: boolean,
): Promise<string | null> => {
  const field: CredField = { env: label, label, secret, required: true };
  const message =
    stored === undefined
      ? label
      : `${label} (stored value present, leave blank to keep)`;
  const value = readPrompt(
    secret
      ? await password({
          message,
          mask: "*",
          validate: validateRequired(field, stored),
        })
      : await text({
          message,
          initialValue: stored,
          validate: validateRequired(field, stored),
        }),
  );
  if (value === null) return null;
  if (value !== undefined && value.length > 0) return value;
  if (stored !== undefined) return stored;
  throw new Error(`${label} is required`);
};

export const runSetup = async (host: SetupHost): Promise<void> => {
  const stored = loadConfig(host.home);
  intro("sandhop setup");
  const providers = readPrompt(
    await multiselect<ProviderId>({
      message: "Configure sandbox provider credentials",
      options: PROVIDER_IDS.map((id) => ({
        value: id,
        label: PROVIDER_INFO[id].label,
        hint: PROVIDER_INFO[id].docsUrl,
      })),
      initialValues: selectedInitialProviders(host, stored),
      required: true,
    }),
  );
  if (providers === null) return;
  const firstProvider = providers[0];
  if (firstProvider === undefined)
    throw new Error("At least one provider is required");

  const credentials: Record<string, string> = {};
  for (const provider of providers) {
    const info = PROVIDER_INFO[provider];
    for (const field of info.credentials) {
      const value = await askCredential(host, stored, info, field);
      if (value === null) return;
      if (value !== undefined) credentials[field.env] = value;
    }
  }

  const storedDefaultProvider = stored?.defaultProvider;
  const defaultProvider = readPrompt(
    await select<ProviderId>({
      message: "Default provider",
      options: providers.map((id) => ({
        value: id,
        label: PROVIDER_INFO[id].label,
      })),
      initialValue:
        storedDefaultProvider !== undefined &&
        providers.includes(storedDefaultProvider)
          ? storedDefaultProvider
          : firstProvider,
    }),
  );
  if (defaultProvider === null) return;

  const transport = readPrompt(
    await select<SandhopTransport>({
      message: "Transport",
      options: [
        { value: "public", label: "public (provider URL + basic auth)" },
        { value: "cloudflared", label: "cloudflared tunnel" },
      ],
      initialValue: stored?.transport,
    }),
  );
  if (transport === null) return;

  let cloudflare: SandhopConfig["cloudflare"];
  if (transport === "cloudflared") {
    const namedTunnel = readPrompt(
      await confirm({
        message: "named tunnel (Access-gated)?",
        initialValue: stored?.cloudflare !== undefined,
      }),
    );
    if (namedTunnel === null) return;
    if (namedTunnel) {
      const token = await askCloudflareValue(
        "Cloudflare tunnel token",
        stored?.cloudflare?.token,
        true,
      );
      if (token === null) return;
      const hostname = await askCloudflareValue(
        "Cloudflare tunnel hostname",
        stored?.cloudflare?.hostname,
        false,
      );
      if (hostname === null) return;
      cloudflare = { token, hostname };
    }
  }

  saveConfig(host.home, {
    defaultProvider,
    transport,
    cloudflare,
    credentials,
  });
  const installed = installCommands(host.home);
  note(
    [
      `Configured providers: ${providers.map((id) => PROVIDER_INFO[id].label).join(", ")}`,
      `Default provider: ${PROVIDER_INFO[defaultProvider].label}`,
      `Transport: ${transport}`,
      installed.length === 0
        ? "No Claude Code or Codex home detected; install /sandhop after opening an agent."
        : `Installed /sandhop to: ${installed.join(", ")}`,
    ].join("\n"),
    "Summary",
  );
  outro(
    "Open Claude Code or Codex in a project and type /sandhop to teleport.",
  );
};
