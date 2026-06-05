import { expect, test } from "vitest";
import { installCommandFor } from "../../../src/core/services/install-cmd.js";
import { FakeHost } from "../../fakes/host.js";

test("installCommandFor chooses JavaScript install command from the root lockfile", () => {
  const cases: [string, string[], string | null][] = [
    [
      "pnpm",
      ["package.json", "pnpm-lock.yaml"],
      "pnpm install --frozen-lockfile",
    ],
    ["yarn", ["package.json", "yarn.lock"], "yarn install --frozen-lockfile"],
    ["npm", ["package.json", "package-lock.json"], "npm ci"],
    ["bun", ["package.json", "bun.lockb"], "bun install --frozen-lockfile"],
    ["none", ["package.json"], null],
  ];

  for (const [name, files, expected] of cases) {
    const host = new FakeHost({
      home: "/home/local",
      env: {},
      files: Object.fromEntries(
        files.map((file) => [`/home/local/${name}/${file}`, ""]),
      ),
    });

    expect(installCommandFor(host, `/home/local/${name}`)).toBe(expected);
  }
});

test("installCommandFor chooses Python install command from the root lockfile", () => {
  const cases: [string, string[], string | null][] = [
    ["poetry", ["poetry.lock"], "poetry install"],
    ["pdm", ["pdm.lock"], "pdm install"],
    ["uv", ["uv.lock"], "uv sync"],
    [
      "requirements",
      ["requirements.txt"],
      "uv pip install -r requirements.txt --system",
    ],
    ["pyproject", ["pyproject.toml"], null],
  ];

  for (const [name, files, expected] of cases) {
    const host = new FakeHost({
      home: "/home/local",
      env: {},
      files: Object.fromEntries(
        files.map((file) => [`/home/local/${name}/${file}`, ""]),
      ),
    });

    expect(installCommandFor(host, `/home/local/${name}`)).toBe(expected);
  }
});
