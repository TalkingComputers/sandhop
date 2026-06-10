import { expect, test } from "vitest";
import { TmuxMultiplexer } from "../../src/multiplexers/tmux.js";

test("TmuxMultiplexer returns tmux install commands", () => {
  expect(new TmuxMultiplexer().install()).toEqual([
    "command -v tmux",
    `printf '%s\\n' 'set -g status off' 'set -g window-size latest' 'set -g focus-events on' > "$HOME/.tmux.conf"`,
  ]);
});

test("TmuxMultiplexer attaches commands to the named tmux session", () => {
  expect(
    new TmuxMultiplexer().attach("sandhop", {
      file: "bash",
      args: ["-lc", "x"],
    }),
  ).toEqual({
    file: "tmux",
    args: ["-u", "new", "-A", "-s", "sandhop", "bash", "-lc", "x"],
  });
});
