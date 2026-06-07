import { isRecord } from "../json.js";

export type PluginScope = "user" | "project" | "local";

export interface PluginInstall {
  name: string;
  scope: PluginScope;
}

export const readMarketplaceSource = (
  path: string,
  name: string,
  value: unknown,
): string => {
  if (!isRecord(value)) throw new Error(`Expected marketplace object ${name}`);
  const source = value.source;
  if (!isRecord(source)) throw new Error(`Expected marketplace source ${name}`);
  const repo = source.repo;
  if (typeof repo === "string") return repo;
  const url = source.url;
  if (typeof url === "string") return url;
  throw new Error(`Expected marketplace repo or url in ${path} for ${name}`);
};

export const readPluginInstalls = (
  path: string,
  value: unknown,
): PluginInstall[] => {
  if (!isRecord(value))
    throw new Error(`Expected installed plugins object at ${path}`);
  const plugins = value.plugins;
  if (!isRecord(plugins)) throw new Error(`Expected plugins map at ${path}`);
  const installs: PluginInstall[] = [];
  for (const [name, records] of Object.entries(plugins)) {
    if (!Array.isArray(records) || records.length === 0)
      throw new Error(
        `Expected non-empty plugin install record array at ${path} for ${name}`,
      );
    for (const record of records) {
      if (!isRecord(record))
        throw new Error(
          `Expected plugin install record at ${path} for ${name}`,
        );
      const scope = record.scope;
      if (scope !== "user" && scope !== "project" && scope !== "local")
        throw new Error(
          `Expected plugin scope user, project, or local at ${path} for ${name}`,
        );
      installs.push({ name, scope });
    }
  }
  return installs;
};

export const readDisabledPlugins = (path: string, value: unknown): string[] => {
  if (!isRecord(value)) throw new Error(`Expected settings object at ${path}`);
  const enabled = value.enabledPlugins;
  if (enabled === undefined) return [];
  if (!isRecord(enabled))
    throw new Error(`Expected enabledPlugins object at ${path}`);
  return Object.entries(enabled)
    .map(([name, state]) => {
      if (state === false) return name;
      if (state === true) return null;
      throw new Error(`Expected boolean enabledPlugins.${name} at ${path}`);
    })
    .filter((name): name is string => name !== null);
};
