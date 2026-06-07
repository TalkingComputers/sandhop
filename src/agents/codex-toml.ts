import { collectEnvRefs } from "../core/env.js";
import type { TomlTable, TomlValue } from "smol-toml";

export const isTomlTable = (value: unknown): value is TomlTable =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  !(value instanceof Date);

export const toTomlTable = (
  value: TomlValue | undefined,
  path: string,
): TomlTable | undefined => {
  if (value === undefined) return undefined;
  if (!isTomlTable(value)) throw new Error(`Expected ${path} to be a table`);
  return value;
};

export const toTomlString = (
  value: TomlValue | undefined,
  path: string,
): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "string")
    throw new Error(`Expected ${path} to be a string`);
  return value;
};

export const toTomlStringArray = (
  value: TomlValue | undefined,
  path: string,
): string[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`Expected ${path} to be an array`);
  return value.map((item, index) => {
    if (typeof item !== "string")
      throw new Error(`Expected ${path}[${index}] to be a string`);
    return item;
  });
};

export const toTomlStringRecord = (
  value: TomlValue | undefined,
  path: string,
): Record<string, string> | undefined => {
  const table = toTomlTable(value, path);
  if (table === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(table).map(([key, field]) => {
      if (typeof field !== "string")
        throw new Error(`Expected ${path}.${key} to be a string`);
      return [key, field];
    }),
  );
};

export const toTomlNumber = (
  value: TomlValue | undefined,
  path: string,
): number | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "number")
    throw new Error(`Expected ${path} to be a number`);
  return value;
};

export const collectEnvRefsFromValue = (
  refs: Set<string>,
  value: TomlValue,
): void => {
  if (typeof value === "string")
    for (const name of collectEnvRefs(value)) refs.add(name);
  else if (Array.isArray(value))
    for (const item of value) collectEnvRefsFromValue(refs, item);
  else if (isTomlTable(value))
    for (const item of Object.values(value))
      collectEnvRefsFromValue(refs, item);
};
