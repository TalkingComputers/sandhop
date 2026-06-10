import { expect, test } from "vitest";
import { mergeForkAncestry } from "../../src/agents/codex-session.js";
import type { AgentSessionDeps } from "../../src/core/ports/agent.js";

const meta = (id: string, forkedFrom?: string): string =>
  JSON.stringify({
    type: "session_meta",
    payload: {
      id,
      cwd: "/proj",
      ...(forkedFrom === undefined ? {} : { forked_from_id: forkedFrom }),
    },
  });

const entry = (text: string): string =>
  JSON.stringify({ type: "response_item", payload: { text } });

const makeDeps = (files: Record<string, string>): AgentSessionDeps => ({
  home: "/home/u",
  readFile: (path: string) => files[path] ?? null,
  walk: () => Object.keys(files),
  statMtimeMs: () => 0,
});

const PARENT_PATH =
  "/home/u/.codex/sessions/2026/06/09/rollout-2026-06-09T10-00-00-parent-id-1.jsonl";

test("mergeForkAncestry prepends parent history when the fork rollout lacks it", () => {
  const parent =
    [meta("parent-id-1"), entry("pam work 1"), entry("pam work 2")].join("\n") +
    "\n";
  const fork =
    [meta("fork-id-2", "parent-id-1"), entry("sandhop push")].join("\n") + "\n";
  const deps = makeDeps({ [PARENT_PATH]: parent });

  const merged = mergeForkAncestry(deps, fork);

  expect(merged.split("\n").filter((line) => line.length > 0)).toEqual([
    meta("fork-id-2", "parent-id-1"),
    entry("pam work 1"),
    entry("pam work 2"),
    entry("sandhop push"),
  ]);
});

test("mergeForkAncestry leaves flushed forks untouched when history is embedded", () => {
  const parent =
    [meta("parent-id-1"), entry("pam work 1"), entry("pam work 2")].join("\n") +
    "\n";
  const fork =
    [
      meta("fork-id-2", "parent-id-1"),
      entry("pam work 1"),
      entry("pam work 2"),
      entry("new turn"),
    ].join("\n") + "\n";
  const deps = makeDeps({ [PARENT_PATH]: parent });

  expect(mergeForkAncestry(deps, fork)).toBe(fork);
});

test("mergeForkAncestry follows multi-level fork chains", () => {
  const grandparentPath =
    "/home/u/.codex/sessions/2026/06/08/rollout-2026-06-08T09-00-00-grand-id-0.jsonl";
  const grandparent =
    [meta("grand-id-0"), entry("original work")].join("\n") + "\n";
  const parent =
    [meta("parent-id-1", "grand-id-0"), entry("mid work")].join("\n") + "\n";
  const fork =
    [meta("fork-id-2", "parent-id-1"), entry("latest")].join("\n") + "\n";
  const deps = makeDeps({
    [grandparentPath]: grandparent,
    [PARENT_PATH]: parent,
  });

  const merged = mergeForkAncestry(deps, fork);

  expect(merged.split("\n").filter((line) => line.length > 0)).toEqual([
    meta("fork-id-2", "parent-id-1"),
    entry("original work"),
    entry("mid work"),
    entry("latest"),
  ]);
});

test("mergeForkAncestry is a no-op for non-forked sessions and missing parents", () => {
  const plain = [meta("solo-id"), entry("hello")].join("\n") + "\n";
  expect(mergeForkAncestry(makeDeps({}), plain)).toBe(plain);

  const orphanFork =
    [meta("fork-id", "gone-id"), entry("hello")].join("\n") + "\n";
  expect(mergeForkAncestry(makeDeps({}), orphanFork)).toBe(orphanFork);
});
