import { expect, test } from "vitest";
import { CODEX } from "../../../src/agents/codex.js";
import { CLAUDE_CODE } from "../../../src/agents/claude-code.js";
import { FakeHost } from "../../fakes/host.js";

test("authEnv ships Claude credentials file from real keychain services", () => {
  const credentials =
    '{"mcpOAuth":{"token":"mcp"},"claudeAiOauth":{"token":"ai"}}';

  expect(
    CLAUDE_CODE.authEnv(
      new FakeHost({
        home: "/home/local",
        env: {},
        keychainValues: {
          "Claude Code-credentials": credentials,
          "Claude Code": "sk-ant-keychain",
        },
      }),
    ),
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

test("authEnv prefers local Claude credentials file and env API key", () => {
  expect(
    CLAUDE_CODE.authEnv(
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
    ),
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

test("authEnv ships every Claude auth environment path and Vertex keyfile", () => {
  expect(
    CLAUDE_CODE.authEnv(
      new FakeHost({
        home: "/home/local",
        env: {
          CLAUDE_CODE_OAUTH_TOKEN: "oauth-token",
          ANTHROPIC_MODEL: "claude-opus-4-6",
          ANTHROPIC_DEFAULT_HAIKU_MODEL: "eu.anthropic.claude-haiku",
          ANTHROPIC_AUTH_TOKEN: "gateway-token",
          ANTHROPIC_BASE_URL: "https://gateway.example",
          ANTHROPIC_CUSTOM_HEADERS: "X-Org: test",
          CLAUDE_CODE_USE_BEDROCK: "1",
          CLAUDE_CODE_SKIP_BEDROCK_AUTH: "1",
          AWS_REGION: "us-east-1",
          AWS_BEARER_TOKEN_BEDROCK: "bedrock-bearer",
          AWS_ACCESS_KEY_ID: "access-key",
          AWS_SECRET_ACCESS_KEY: "secret-key",
          AWS_SESSION_TOKEN: "session-token",
          ANTHROPIC_BEDROCK_BASE_URL: "https://bedrock.example",
          ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION: "us-west-2",
          CLAUDE_CODE_USE_VERTEX: "1",
          ANTHROPIC_VERTEX_PROJECT_ID: "vertex-project",
          CLOUD_ML_REGION: "us-central1",
          ANTHROPIC_VERTEX_BASE_URL: "https://vertex.example",
          VERTEX_REGION_CLAUDE_4_6_OPUS: "europe-west4",
          GOOGLE_APPLICATION_CREDENTIALS: "/home/local/google.json",
        },
        files: {
          "/home/local/google.json": '{"type":"service_account"}',
        },
      }),
    ),
  ).toEqual({
    envs: {
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-token",
      ANTHROPIC_MODEL: "claude-opus-4-6",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "eu.anthropic.claude-haiku",
      ANTHROPIC_AUTH_TOKEN: "gateway-token",
      ANTHROPIC_BASE_URL: "https://gateway.example",
      ANTHROPIC_CUSTOM_HEADERS: "X-Org: test",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_SKIP_BEDROCK_AUTH: "1",
      AWS_REGION: "us-east-1",
      AWS_BEARER_TOKEN_BEDROCK: "bedrock-bearer",
      AWS_ACCESS_KEY_ID: "access-key",
      AWS_SECRET_ACCESS_KEY: "secret-key",
      AWS_SESSION_TOKEN: "session-token",
      ANTHROPIC_BEDROCK_BASE_URL: "https://bedrock.example",
      ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION: "us-west-2",
      CLAUDE_CODE_USE_VERTEX: "1",
      ANTHROPIC_VERTEX_PROJECT_ID: "vertex-project",
      CLOUD_ML_REGION: "us-central1",
      ANTHROPIC_VERTEX_BASE_URL: "https://vertex.example",
      VERTEX_REGION_CLAUDE_4_6_OPUS: "europe-west4",
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

test("authEnv ships Foundry, Mantle, and Claude-on-AWS platform credentials", () => {
  expect(
    CLAUDE_CODE.authEnv(
      new FakeHost({
        home: "/home/local",
        env: {
          CLAUDE_CODE_USE_FOUNDRY: "1",
          ANTHROPIC_FOUNDRY_API_KEY: "foundry-key",
          ANTHROPIC_FOUNDRY_RESOURCE: "my-resource",
          CLAUDE_CODE_USE_MANTLE: "1",
          ANTHROPIC_BEDROCK_MANTLE_BASE_URL: "https://mantle.example",
          CLAUDE_CODE_USE_ANTHROPIC_AWS: "1",
          ANTHROPIC_AWS_API_KEY: "aws-workspace-key",
          ANTHROPIC_AWS_WORKSPACE_ID: "ws-1",
          AWS_REGION: "us-east-1",
        },
      }),
    ).envs,
  ).toEqual({
    CLAUDE_CODE_USE_FOUNDRY: "1",
    ANTHROPIC_FOUNDRY_API_KEY: "foundry-key",
    ANTHROPIC_FOUNDRY_RESOURCE: "my-resource",
    CLAUDE_CODE_USE_MANTLE: "1",
    ANTHROPIC_BEDROCK_MANTLE_BASE_URL: "https://mantle.example",
    CLAUDE_CODE_USE_ANTHROPIC_AWS: "1",
    ANTHROPIC_AWS_API_KEY: "aws-workspace-key",
    ANTHROPIC_AWS_WORKSPACE_ID: "ws-1",
    AWS_REGION: "us-east-1",
  });
});

test("authEnv throws when Claude has no supported credential path", () => {
  expect(() =>
    CLAUDE_CODE.authEnv(new FakeHost({ home: "/home/local", env: {} })),
  ).toThrow(
    "No Claude Code credential found. Provide one of: ~/.claude/.credentials.json, keychain service Claude Code-credentials, ANTHROPIC_API_KEY, keychain service Claude Code, CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_AUTH_TOKEN, or a third-party platform flag (CLAUDE_CODE_USE_BEDROCK, CLAUDE_CODE_USE_MANTLE, CLAUDE_CODE_USE_ANTHROPIC_AWS, CLAUDE_CODE_USE_FOUNDRY, CLAUDE_CODE_USE_VERTEX)",
  );
});

test("authEnv ships non-empty Codex auth file or OpenAI env token", () => {
  expect(
    CODEX.authEnv(
      new FakeHost({
        home: "/home/local",
        env: {},
        files: {
          "/home/local/.codex/auth.json": "{}",
          "/home/local/.codex/config.toml": 'approval_policy = "on-request"\n',
        },
      }),
    ),
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
    CODEX.authEnv(
      new FakeHost({
        home: "/home/local",
        env: { OPENAI_API_KEY: "sk-openai" },
      }),
    ),
  ).toEqual({ envs: { OPENAI_API_KEY: "sk-openai" }, files: [] });
});

test("authEnv recovers Codex auth from the OS keychain when auth.json is empty", () => {
  const host = new FakeHost({
    home: "/home/local",
    env: {},
    files: { "/home/local/.codex/auth.json": "" },
  });
  const account = `cli|${host.sha256Hex("/home/local/.codex").slice(0, 16)}`;
  host.keychainValues[`Codex Auth:${account}`] = '{"tokens":"keychain"}';

  expect(CODEX.authEnv(host)).toEqual({
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

test("authEnv throws when Codex has no file, keychain, or API key", () => {
  expect(() =>
    CODEX.authEnv(new FakeHost({ home: "/home/local", env: {} })),
  ).toThrow(
    "No Codex credential at ~/.codex/auth.json, OS keychain, OPENAI_API_KEY, or CODEX_API_KEY",
  );
});
