import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") && !path.endsWith("no-raw-shell.spec.ts")
      ? [path]
      : [];
  });

test("source has no deleted shell helper imports", () => {
  const offenders = sourceFiles("src").filter((path) =>
    /from ["'].*\/shell\.js["']|shellQuote|quoteHomePath|quoteShellPath|SUDO_SETUP|SANDHOP_OWNER_SETUP|spawnPipe\(|node -e|\bpgrep\b|verifyTerminalReady|spawnShell|ttydBindAddress/.test(
      readFileSync(path, "utf8"),
    ),
  );

  expect(offenders).toEqual([]);
});

test("raw provider APIs are replaced by file args and shell boundary methods", () => {
  const ports = readFileSync(
    join("src", "core", "ports", "provider.ts"),
    "utf8",
  );

  expect(ports).not.toContain("exec(cmd: string");
  expect(ports).not.toContain("spawn(cmd: string");
  expect(ports).toMatch(/exec\(\s*file: string,\s*args: readonly string\[]/);
  expect(ports).toContain("export const execShell");
  expect(ports).not.toContain("export const spawnShell");
  expect(ports).toContain("startService(service: ServiceSpec)");
});
