import type { Multiplexer } from "../core/ports/multiplexer.js";

export class TmuxMultiplexer implements Multiplexer {
  readonly id = "tmux";

  install(): string[] {
    return [
      `command -v tmux >/dev/null 2>&1 || $SUDO sh -c '(apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y tmux) || dnf install -y tmux || yum install -y tmux || apk add --no-cache tmux'`,
      `printf '%s\\n' 'set -g status off' 'set -g window-size latest' > "$HOME/.tmux.conf"`,
    ];
  }

  attach(session: string, command: string): string {
    return `tmux new -A -s ${session} ${command}`;
  }
}
