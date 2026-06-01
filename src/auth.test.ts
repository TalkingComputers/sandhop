import { expect, test } from "vitest";
import { extractAuth } from "./auth.js";

const base = {
  env: {},
  keychain: () => null,
  readFile: () => null,
  home: "/h",
};

test("claude code prefers ANTHROPIC_API_KEY env", () => {
  const a = extractAuth("claude-code", {
    ...base,
    env: { ANTHROPIC_API_KEY: "sk-ant-api03-x" },
  });
  expect(a.envs).toEqual({ ANTHROPIC_API_KEY: "sk-ant-api03-x" });
});

test("claude code reads api key from keychain", () => {
  const a = extractAuth("claude-code", {
    ...base,
    keychain: (s) => (s === "Claude Code" ? "sk-ant-api03-y" : null),
  });
  expect(a.envs.ANTHROPIC_API_KEY).toBe("sk-ant-api03-y");
});

test("claude code throws when no credential", () => {
  expect(() => extractAuth("claude-code", base)).toThrow(/setup-token/);
});

test("codex ships auth.json file", () => {
  const a = extractAuth("codex", {
    ...base,
    readFile: (p) => (p === "/h/.codex/auth.json" ? '{"x":1}' : null),
  });
  expect(a.files).toEqual([
    { path: "$HOME/.codex/auth.json", content: '{"x":1}' },
  ]);
});

test("codex throws when no credential", () => {
  expect(() => extractAuth("codex", base)).toThrow(/OPENAI_API_KEY/);
});
