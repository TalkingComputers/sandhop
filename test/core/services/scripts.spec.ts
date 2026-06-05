import { expect, test } from "vitest";
import { ScriptCaptureService } from "../../../src/core/services/scripts.js";
import { FakeHost } from "../../fakes/host.js";

test("ScriptCaptureService maps local scripts from Claude settings and rewrites only captured paths", () => {
  const host = new FakeHost({
    home: "/home/local",
    env: {},
    files: {
      "/home/local/.claude/settings.json": JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [
                {
                  type: "command",
                  command: "/home/local/hook-app/bin/hook.sh --strict",
                },
                { type: "command", command: "echo inline" },
              ],
            },
          ],
        },
        statusLine: {
          type: "command",
          command: "~/.claude/statusline.sh --json",
        },
        apiKeyHelper: "$HOME/bin/api-key-helper.sh",
      }),
      "/home/local/work/.claude/settings.json": JSON.stringify({
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: "command",
                  command: "python ./scripts/project-hook.py",
                },
              ],
            },
          ],
        },
      }),
      "/home/local/hook-app/package.json": "{}",
      "/home/local/hook-app/bin/hook.sh": "#!/bin/sh\n",
      "/home/local/.claude/statusline.sh": "#!/bin/sh\n",
      "/home/local/bin/api-key-helper.sh": "#!/bin/sh\n",
      "/home/local/work/scripts/project-hook.py": "#!/usr/bin/env python\n",
    },
    execValues: {
      "git -C /home/local/hook-app/bin rev-parse --show-toplevel":
        "/home/local/hook-app\n",
      "git -C /home/local/hook-app rev-parse --show-toplevel":
        "/home/local/hook-app\n",
    },
  });

  const plan = new ScriptCaptureService(host).plan(
    "/home/local/work",
    "/home/user",
  );

  expect(plan.mappings).toEqual([
    {
      localPath: "/home/local/.claude/statusline.sh",
      sandboxPath: "/home/user/.claude/statusline.sh",
    },
    {
      localPath: "/home/local/bin/api-key-helper.sh",
      sandboxPath: "/home/user/bin/api-key-helper.sh",
    },
    { localPath: "/home/local/hook-app", sandboxPath: "/home/user/hook-app" },
    {
      localPath: "/home/local/work/scripts/project-hook.py",
      sandboxPath: "/home/user/work/scripts/project-hook.py",
    },
  ]);
  expect(plan.rewrites.map((rewrite) => rewrite.sandboxPath)).toEqual([
    "/home/user/.claude/settings.json",
    "/home/local/work/.claude/settings.json",
  ]);

  const userSettings = JSON.parse(plan.rewrites[0]!.content) as {
    hooks: {
      PreToolUse: {
        hooks: { command: string }[];
      }[];
    };
    statusLine: { command: string };
    apiKeyHelper: string;
  };
  const projectSettings = JSON.parse(plan.rewrites[1]!.content) as {
    hooks: { Stop: { hooks: { command: string }[] }[] };
  };

  expect(userSettings.hooks.PreToolUse[0]!.hooks[0]!.command).toBe(
    "/home/user/hook-app/bin/hook.sh --strict",
  );
  expect(userSettings.hooks.PreToolUse[0]!.hooks[1]!.command).toBe(
    "echo inline",
  );
  expect(userSettings.statusLine.command).toBe(
    "/home/user/.claude/statusline.sh --json",
  );
  expect(userSettings.apiKeyHelper).toBe("/home/user/bin/api-key-helper.sh");
  expect(projectSettings.hooks.Stop[0]!.hooks[0]!.command).toBe(
    "python /home/user/work/scripts/project-hook.py",
  );
});
