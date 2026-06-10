import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { NodeHost } from "../../src/host/node.js";

test("NodeHost tarZstd excludes path segments at any depth via system tar", async () => {
  const root = mkdtempSync(join(tmpdir(), "sandhop-tarzstd-"));
  mkdirSync(join(root, "src/node_modules/pkg"), { recursive: true });
  mkdirSync(join(root, "deep/a/node_modules/x"), { recursive: true });
  mkdirSync(join(root, "node_modules"), { recursive: true });
  mkdirSync(join(root, "keep"), { recursive: true });
  writeFileSync(join(root, "src/main.ts"), "main");
  writeFileSync(join(root, "src/node_modules/pkg/index.js"), "pkg");
  writeFileSync(join(root, "deep/a/node_modules/x/y.js"), "nested");
  writeFileSync(join(root, "node_modules/top.js"), "top");
  writeFileSync(join(root, "keep/file.txt"), "keep");
  writeFileSync(join(root, "node_modules_lookalike.txt"), "kept");
  const out = join(root, "out.tar.zst");
  const host = new NodeHost(process.env, process.env["HOME"]!);

  await host.tarZstd(root, ["."], out, {
    excludes: ["node_modules", "out.tar.zst"],
  });

  const members = execFileSync("bash", ["-c", `zstd -dc ${out} | tar -tf -`], {
    encoding: "utf8",
  })
    .split("\n")
    .filter((line) => line.length > 0)
    .sort();
  expect(members).toContain("./src/main.ts");
  expect(members).toContain("./keep/file.txt");
  expect(members).toContain("./node_modules_lookalike.txt");
  expect(members.join("\n")).not.toContain("node_modules/");
});

test("NodeHost tarZstd skips unreadable directories and reports them instead of failing", async () => {
  const root = mkdtempSync(join(tmpdir(), "sandhop-tarskip-"));
  mkdirSync(join(root, "keep"), { recursive: true });
  mkdirSync(join(root, "blocked"), { recursive: true });
  writeFileSync(join(root, "keep/file.txt"), "keep");
  writeFileSync(join(root, "keep/noread.txt"), "noread");
  writeFileSync(join(root, "blocked/secret.txt"), "blocked");
  chmodSync(join(root, "blocked"), 0o000);
  chmodSync(join(root, "keep/noread.txt"), 0o000);
  const out = join(tmpdir(), `sandhop-tarskip-out-${Date.now()}.tar.zst`);
  const host = new NodeHost(process.env, process.env["HOME"]!);

  try {
    const result = await host.tarZstd(root, ["."], out);

    expect(result.skippedPaths.sort()).toEqual([
      "./blocked",
      "./keep/noread.txt",
    ]);
    const members = execFileSync(
      "bash",
      ["-c", `zstd -dc ${out} | tar -tf -`],
      { encoding: "utf8" },
    )
      .split("\n")
      .filter((line) => line.length > 0);
    expect(members).toContain("./keep/file.txt");
    expect(members.join("\n")).not.toContain("secret.txt");
    expect(members.join("\n")).not.toContain("noread.txt");
  } finally {
    chmodSync(join(root, "blocked"), 0o755);
    chmodSync(join(root, "keep/noread.txt"), 0o644);
  }
});

test("NodeHost tarZstd still fails on a missing source directory", async () => {
  const host = new NodeHost(process.env, process.env["HOME"]!);
  const out = join(tmpdir(), `sandhop-tarfail-${Date.now()}.tar.zst`);

  await expect(
    host.tarZstd(join(tmpdir(), "sandhop-does-not-exist"), ["."], out),
  ).rejects.toThrow();
});
