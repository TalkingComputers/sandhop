import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { buildTerminalProxyScript } from "../../../src/core/services/terminal-proxy.js";

const LISTEN_PORT = 17681;
const UPSTREAM_PORT = 17682;

let upstream: http.Server;
let proxy: ChildProcess;
const upgradeHeaders: Record<string, string | undefined>[] = [];

const httpGet = (
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> =>
  new Promise((done, fail) => {
    const req = http.request(
      { host: "127.0.0.1", port: LISTEN_PORT, path, headers },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => (body += chunk.toString()));
        res.on("end", () => done({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", fail);
    req.end();
  });

const waitForListen = async (): Promise<void> => {
  for (let i = 0; i < 50; i++) {
    try {
      await httpGet("/", {});
      return;
    } catch {
      await new Promise((tick) => setTimeout(tick, 100));
    }
  }
  throw new Error("proxy never started listening");
};

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(`upstream saw auth=${req.headers.authorization ?? "none"}`);
  });
  upstream.on("upgrade", (req, socket) => {
    upgradeHeaders.push({ authorization: req.headers.authorization });
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
    );
    socket.end();
  });
  await new Promise<void>((done) =>
    upstream.listen(UPSTREAM_PORT, "127.0.0.1", done),
  );
  const dir = mkdtempSync(join(tmpdir(), "sandhop-proxy-"));
  const scriptPath = join(dir, "proxy.cjs");
  const htmlPath = join(dir, "terminal.html");
  writeFileSync(htmlPath, "<html>sandhop-test-frontend</html>");
  writeFileSync(
    scriptPath,
    buildTerminalProxyScript(
      "user",
      "pw",
      "127.0.0.1",
      LISTEN_PORT,
      UPSTREAM_PORT,
      htmlPath,
    ),
  );
  proxy = spawn("node", [scriptPath], { stdio: "ignore" });
  await waitForListen();
});

afterAll(async () => {
  proxy.kill();
  await new Promise((done) => upstream.close(done));
});

test("proxy rejects plain HTTP without basic auth", async () => {
  const res = await httpGet("/", {});
  expect(res.status).toBe(401);
});

test("proxy forwards authenticated HTTP to ttyd", async () => {
  const auth = `Basic ${Buffer.from("user:pw").toString("base64")}`;
  const res = await httpGet("/token", { authorization: auth });
  expect(res.status).toBe(200);
  expect(res.body).toBe(`upstream saw auth=${auth}`);
});

test("proxy serves the custom frontend at the root path", async () => {
  const auth = `Basic ${Buffer.from("user:pw").toString("base64")}`;
  const res = await httpGet("/", { authorization: auth });
  expect(res.status).toBe(200);
  expect(res.body).toBe("<html>sandhop-test-frontend</html>");
  const unauth = await httpGet("/", {});
  expect(unauth.status).toBe(401);
});

test("proxy injects basic auth on websocket upgrades missing it (Safari)", async () => {
  await new Promise<void>((done, fail) => {
    const req = http.request({
      host: "127.0.0.1",
      port: LISTEN_PORT,
      path: "/ws",
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version": "13",
      },
    });
    req.on("upgrade", (res, socket) => {
      socket.destroy();
      try {
        expect(res.statusCode).toBe(101);
        done();
      } catch (error: unknown) {
        fail(error as Error);
      }
    });
    req.on("error", fail);
    req.end();
  });
  expect(upgradeHeaders[0]?.authorization).toBe(
    `Basic ${Buffer.from("user:pw").toString("base64")}`,
  );
});
