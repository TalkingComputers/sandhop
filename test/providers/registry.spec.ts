import { expect, test } from "vitest";
import { CredentialError } from "../../src/core/errors.js";
import {
  PROVIDER_IDS,
  PROVIDER_INFO,
  buildProvider,
  requireCred,
  resolveCredentials,
} from "../../src/providers/index.js";
import { FakeHost } from "../fakes/host.js";

test("provider registry lists e2b, modal, daytona, and vercel", () => {
  expect(PROVIDER_IDS).toEqual(["e2b", "modal", "daytona", "vercel"]);
});

test("provider registry builds all supported providers", async () => {
  const host = new FakeHost({ home: "/home/local", env: {} });

  expect((await buildProvider("e2b", host, { E2B_API_KEY: "key" })).name).toBe(
    "e2b",
  );
  expect(
    (
      await buildProvider("modal", host, {
        MODAL_TOKEN_ID: "id",
        MODAL_TOKEN_SECRET: "secret",
      })
    ).name,
  ).toBe("modal");
  expect(
    (await buildProvider("daytona", host, { DAYTONA_API_KEY: "key" })).name,
  ).toBe("daytona");
  expect(
    (
      await buildProvider("vercel", host, {
        VERCEL_TOKEN: "token",
        VERCEL_TEAM_ID: "team",
        VERCEL_PROJECT_ID: "project",
      })
    ).name,
  ).toBe("vercel");
});

test("PROVIDER_INFO declares credential prompts for every provider", () => {
  expect(PROVIDER_INFO).toEqual({
    e2b: {
      id: "e2b",
      label: "E2B",
      docsUrl: "https://e2b.dev/dashboard?tab=keys",
      credentials: [
        {
          env: "E2B_API_KEY",
          label: "E2B API key",
          secret: true,
          required: true,
        },
      ],
    },
    modal: {
      id: "modal",
      label: "Modal",
      docsUrl: "https://modal.com/settings/tokens",
      credentials: [
        {
          env: "MODAL_TOKEN_ID",
          label: "Modal token id",
          secret: false,
          required: true,
        },
        {
          env: "MODAL_TOKEN_SECRET",
          label: "Modal token secret",
          secret: true,
          required: true,
        },
      ],
    },
    daytona: {
      id: "daytona",
      label: "Daytona",
      docsUrl: "https://app.daytona.io/dashboard/keys",
      credentials: [
        {
          env: "DAYTONA_API_KEY",
          label: "Daytona API key",
          secret: true,
          required: true,
        },
        {
          env: "DAYTONA_API_URL",
          label: "Daytona API URL (optional)",
          secret: false,
          required: false,
        },
        {
          env: "DAYTONA_TARGET",
          label: "Daytona target region (optional)",
          secret: false,
          required: false,
        },
      ],
    },
    vercel: {
      id: "vercel",
      label: "Vercel Sandbox",
      docsUrl: "https://vercel.com/account/tokens",
      credentials: [
        {
          env: "VERCEL_TOKEN",
          label: "Vercel token",
          secret: true,
          required: true,
        },
        {
          env: "VERCEL_TEAM_ID",
          label: "Vercel team id (team_...)",
          secret: false,
          required: true,
        },
        {
          env: "VERCEL_PROJECT_ID",
          label: "Vercel project id (prj_...)",
          secret: false,
          required: true,
        },
      ],
    },
  });
  expect(Object.keys(PROVIDER_INFO).sort()).toEqual([...PROVIDER_IDS].sort());
  for (const id of PROVIDER_IDS)
    expect(PROVIDER_INFO[id].credentials.some((field) => field.required)).toBe(
      true,
    );
});

test("resolveCredentials merges env over stored config and validates required fields", () => {
  expect(
    resolveCredentials(
      "daytona",
      { DAYTONA_API_KEY: "env-key", DAYTONA_API_URL: "" },
      { DAYTONA_API_KEY: "stored-key", DAYTONA_TARGET: "eu" },
    ),
  ).toEqual({ DAYTONA_API_KEY: "env-key", DAYTONA_TARGET: "eu" });
  expect(
    resolveCredentials("e2b", {}, { E2B_API_KEY: "stored-key", BOGUS: "x" }),
  ).toEqual({ E2B_API_KEY: "stored-key" });

  let error: unknown;
  try {
    resolveCredentials("daytona", {}, undefined);
  } catch (caught: unknown) {
    error = caught;
  }

  expect(error).toBeInstanceOf(CredentialError);
  expect(error).toMatchObject({
    message: "DAYTONA_API_KEY is required — set it or run `sandhop setup`",
  });
});

test("requireCred reads resolved credentials and throws CredentialError when absent", () => {
  expect(requireCred({ E2B_API_KEY: "e2b-key" }, "E2B_API_KEY")).toBe(
    "e2b-key",
  );
  expect(() => requireCred({}, "E2B_API_KEY")).toThrow(
    "E2B_API_KEY is required — set it or run `sandhop setup`",
  );
});
