export const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", "'\\''")}'`;

export const shellLog = (value: string): string =>
  value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("$", "\\$")
    .replaceAll("`", "\\`");

export const quoteHomePath = (path: string): string =>
  path.startsWith("$HOME") ? `"${path}"` : path;

export const quoteShellPath = (value: string): string =>
  `"${shellLog(value)
    .replaceAll("\\$HOME", "$HOME")
    .replaceAll("\\${HOME}", "${HOME}")}"`;

export const LOW_PRIORITY_SETUP =
  'KEEPON_LOW_PRIORITY="nice -n 19"; if command -v ionice >/dev/null 2>&1; then KEEPON_LOW_PRIORITY="nice -n 19 ionice -c3"; fi';

export const SUDO_SETUP =
  'SUDO=""; if [ "$(id -u)" != 0 ] && command -v sudo >/dev/null 2>&1; then SUDO="sudo"; fi';

export const nonFatal = (cmd: string): string =>
  `${cmd} || { echo "[keepon] step failed: ${shellLog(cmd)}" >&2; true; }`;

export const runLowPriority = (cmd: string): string =>
  `$KEEPON_LOW_PRIORITY sh -lc ${shellQuote(cmd)}`;
