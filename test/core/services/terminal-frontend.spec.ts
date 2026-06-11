import { expect, test } from "vitest";
import { buildTerminalFrontendHtml } from "../../../src/core/services/terminal-frontend.js";

test("terminal frontend locks the grid to the first client and never resizes the pty", () => {
  const html = buildTerminalFrontendHtml();

  expect(html).toContain('fetchJson("/size")');
  expect(html).toContain("term.resize(size.cols, size.rows)");
  expect(html).toContain("@xterm/addon-fit@0.10.0");
  expect(html).toContain('new WebSocket(wsUrl, ["tty"])');
  expect(html).toContain(
    "AuthToken: token, columns: term.cols, rows: term.rows",
  );
  expect(html).not.toContain('"1" + JSON.stringify');
  expect(html).not.toContain("transform");
  expect(html).not.toContain("addon-webgl");
  expect(html).not.toContain("WebglAddon");
  expect(html).toContain("@xterm/xterm@5.5.0");
});
