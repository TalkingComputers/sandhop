import type { HostDeps } from "./ports/host.js";

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const parseJsonRecord = (
  text: string,
): Record<string, unknown> | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  return isRecord(parsed) ? parsed : null;
};

export const readJsonRecord = (
  host: Pick<HostDeps, "readFile">,
  path: string,
): Record<string, unknown> | null => {
  const text = host.readFile(path);
  return text === null ? null : parseJsonRecord(text);
};
