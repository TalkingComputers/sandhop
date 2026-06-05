import { expect, test } from "vitest";
import { CODEX } from "../../../src/agents/codex.js";
import { CLAUDE_CODE } from "../../../src/agents/claude-code.js";
import { AuthService } from "../../../src/core/services/auth.js";
import { FakeHost } from "../../fakes/host.js";

test("AuthService extracts Claude API key from env or keychain", () => {
  expect(
    new AuthService(
      new FakeHost({
        home: "/home/local",
        env: { ANTHROPIC_API_KEY: "sk-ant-api03-env" },
      }),
      CLAUDE_CODE,
    ).extract(),
  ).toEqual({ envs: { ANTHROPIC_API_KEY: "sk-ant-api03-env" }, files: [] });

  expect(
    new AuthService(
      new FakeHost({
        home: "/home/local",
        env: {},
        keychainValues: { "Claude Code": "sk-ant-api03-keychain" },
      }),
      CLAUDE_CODE,
    ).extract(),
  ).toEqual({
    envs: { ANTHROPIC_API_KEY: "sk-ant-api03-keychain" },
    files: [],
  });
});

test("AuthService ships non-empty Codex auth file or OpenAI env token", () => {
  expect(
    new AuthService(
      new FakeHost({
        home: "/home/local",
        env: {},
        files: {
          "/home/local/.codex/auth.json": "{}",
          "/home/local/.codex/config.toml": 'approval_policy = "on-request"\n',
        },
      }),
      CODEX,
    ).extract(),
  ).toEqual({
    envs: {},
    files: [
      { path: "$HOME/.codex/auth.json", content: "{}" },
      {
        path: "$HOME/.codex/config.toml",
        content: 'approval_policy = "on-request"\n',
      },
    ],
  });

  expect(
    new AuthService(
      new FakeHost({
        home: "/home/local",
        env: { OPENAI_API_KEY: "sk-openai" },
      }),
      CODEX,
    ).extract(),
  ).toEqual({ envs: { OPENAI_API_KEY: "sk-openai" }, files: [] });
});

test("AuthService recovers Codex auth from the OS keychain when auth.json is empty", () => {
  const host = new FakeHost({
    home: "/home/local",
    env: {},
    files: { "/home/local/.codex/auth.json": "" },
  });
  const account = `cli|${host.sha256Hex("/home/local/.codex").slice(0, 16)}`;
  host.keychainValues[`Codex Auth:${account}`] = '{"tokens":"keychain"}';

  expect(new AuthService(host, CODEX).extract()).toEqual({
    envs: {},
    files: [
      { path: "$HOME/.codex/auth.json", content: '{"tokens":"keychain"}' },
    ],
  });
});

test("AuthService throws when Codex has no file, keychain, or API key", () => {
  expect(() =>
    new AuthService(
      new FakeHost({ home: "/home/local", env: {} }),
      CODEX,
    ).extract(),
  ).toThrow(
    "No Codex credential at ~/.codex/auth.json, OS keychain, OPENAI_API_KEY, or CODEX_API_KEY",
  );
});
