import { expect, test } from "vitest";
import type { ProviderId } from "../../src/providers/index.js";
import {
  PROVIDER_IDS,
  PROVIDER_INFO,
  buildProvider,
} from "../../src/providers/index.js";
import { FakeHost } from "../fakes/host.js";

test("provider registry lists e2b, modal, daytona, and vercel", () => {
  expect(PROVIDER_IDS).toEqual(["e2b", "modal", "daytona", "vercel"]);
});

test("provider registry builds all supported providers", () => {
  const host = new FakeHost({ home: "/home/local", env: {} });

  expect(buildProvider("e2b", host).name).toBe("e2b");
  expect(buildProvider("modal", host).name).toBe("modal");
  expect(buildProvider("daytona", host).name).toBe("daytona");
  expect(buildProvider("vercel", host).name).toBe("vercel");
});

test("provider registry rejects unknown providers", () => {
  const host = new FakeHost({ home: "/home/local", env: {} });

  expect(() => buildProvider("bogus" as ProviderId, host)).toThrow(
    "Unknown provider bogus",
  );
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
