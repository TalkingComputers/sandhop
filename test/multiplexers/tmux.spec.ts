import { expect, test } from "vitest";
import { TmuxMultiplexer } from "../../src/multiplexers/tmux.js";

test("TmuxMultiplexer returns tmux install commands", () => {
  expect(new TmuxMultiplexer().install()).toEqual([
    "command -v tmux >/dev/null 2>&1 || $SUDO sh -c '(apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y tmux) || dnf install -y tmux || yum install -y tmux || apk add --no-cache tmux'",
    `printf '%s\\n' 'set -g status off' 'set -g window-size latest' > "$HOME/.tmux.conf"`,
  ]);
});

test("TmuxMultiplexer attaches commands to the named tmux session", () => {
  expect(new TmuxMultiplexer().attach("sandhop", "bash -lc 'x'")).toBe(
    "tmux new -A -s sandhop bash -lc 'x'",
  );
});
