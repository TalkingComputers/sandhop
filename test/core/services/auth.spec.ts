import { expect, test } from "vitest";
import { CODEX } from "../../../src/agents/codex.js";
import { CLAUDE_CODE } from "../../../src/agents/claude-code.js";
import { AuthService } from "../../../src/core/services/auth.js";
import { FakeHost } from "../../fakes/host.js";

test("AuthService ships Claude credentials file from real keychain services", () => {
  const credentials =
    '{"mcpOAuth":{"token":"mcp"},"claudeAiOauth":{"token":"ai"}}';

  expect(
    new AuthService(
      new FakeHost({
        home: "/home/local",
        env: {},
        keychainValues: {
          "Claude Code-credentials": credentials,
          "Claude Code": "sk-ant-keychain",
        },
      }),
      CLAUDE_CODE,
    ).extract(),
  ).toEqual({
    envs: { ANTHROPIC_API_KEY: "sk-ant-keychain" },
    files: [
      {
        path: "$HOME/.claude/.credentials.json",
        content: credentials,
        mode: "600",
      },
    ],
  });
});

test("AuthService prefers local Claude credentials file and env API key", () => {
  expect(
    new AuthService(
      new FakeHost({
        home: "/home/local",
        env: { ANTHROPIC_API_KEY: "sk-ant-env" },
        files: {
          "/home/local/.claude/.credentials.json": '{"local":"credentials"}',
        },
        keychainValues: {
          "Claude Code-credentials": '{"keychain":"credentials"}',
        },
      }),
      CLAUDE_CODE,
    ).extract(),
  ).toEqual({
    envs: { ANTHROPIC_API_KEY: "sk-ant-env" },
    files: [
      {
        path: "$HOME/.claude/.credentials.json",
        content: '{"local":"credentials"}',
        mode: "600",
      },
    ],
  });
});

test("AuthService ships every Claude auth environment path and Vertex keyfile", () => {
  expect(
    new AuthService(
      new FakeHost({
        home: "/home/local",
        env: {
          CLAUDE_CODE_OAUTH_TOKEN: "oauth-token",
          ANTHROPIC_AUTH_TOKEN: "gateway-token",
          ANTHROPIC_BASE_URL: "https://gateway.example",
          ANTHROPIC_CUSTOM_HEADERS: "X-Org: test",
          CLAUDE_CODE_USE_BEDROCK: "1",
          AWS_REGION: "us-east-1",
          AWS_BEARER_TOKEN_BEDROCK: "bedrock-bearer",
          AWS_ACCESS_KEY_ID: "access-key",
          AWS_SECRET_ACCESS_KEY: "secret-key",
          AWS_SESSION_TOKEN: "session-token",
          ANTHROPIC_BEDROCK_BASE_URL: "https://bedrock.example",
          CLAUDE_CODE_USE_VERTEX: "1",
          ANTHROPIC_VERTEX_PROJECT_ID: "vertex-project",
          CLOUD_ML_REGION: "us-central1",
          ANTHROPIC_VERTEX_BASE_URL: "https://vertex.example",
          GOOGLE_APPLICATION_CREDENTIALS: "/home/local/google.json",
        },
        files: {
          "/home/local/google.json": '{"type":"service_account"}',
        },
      }),
      CLAUDE_CODE,
    ).extract(),
  ).toEqual({
    envs: {
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-token",
      ANTHROPIC_AUTH_TOKEN: "gateway-token",
      ANTHROPIC_BASE_URL: "https://gateway.example",
      ANTHROPIC_CUSTOM_HEADERS: "X-Org: test",
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_REGION: "us-east-1",
      AWS_BEARER_TOKEN_BEDROCK: "bedrock-bearer",
      AWS_ACCESS_KEY_ID: "access-key",
      AWS_SECRET_ACCESS_KEY: "secret-key",
      AWS_SESSION_TOKEN: "session-token",
      ANTHROPIC_BEDROCK_BASE_URL: "https://bedrock.example",
      CLAUDE_CODE_USE_VERTEX: "1",
      ANTHROPIC_VERTEX_PROJECT_ID: "vertex-project",
      CLOUD_ML_REGION: "us-central1",
      ANTHROPIC_VERTEX_BASE_URL: "https://vertex.example",
      GOOGLE_APPLICATION_CREDENTIALS: "$HOME/.sandhop/google-creds.json",
    },
    files: [
      {
        path: "$HOME/.sandhop/google-creds.json",
        content: '{"type":"service_account"}',
        mode: "600",
      },
    ],
  });
});

test("AuthService throws when Claude has no supported credential path", () => {
  expect(() =>
    new AuthService(
      new FakeHost({ home: "/home/local", env: {} }),
      CLAUDE_CODE,
    ).extract(),
  ).toThrow(
    "No Claude Code credential found. Provide one of: ~/.claude/.credentials.json, keychain service Claude Code-credentials, ANTHROPIC_API_KEY, keychain service Claude Code, CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_AUTH_TOKEN, CLAUDE_CODE_USE_BEDROCK, CLAUDE_CODE_USE_VERTEX",
  );
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
      { path: "$HOME/.codex/auth.json", content: "{}", mode: "600" },
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
      {
        path: "$HOME/.codex/auth.json",
        content: '{"tokens":"keychain"}',
        mode: "600",
      },
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
