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

test("AuthService ships Codex auth file or OpenAI env token", () => {
  expect(
    new AuthService(
      new FakeHost({
        home: "/home/local",
        env: {},
        files: { "/home/local/.codex/auth.json": "{}" },
      }),
      CODEX,
    ).extract(),
  ).toEqual({
    envs: {},
    files: [{ path: "$HOME/.codex/auth.json", content: "{}" }],
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
