import { chmod, rm } from "node:fs/promises";
import { execa } from "execa";

await rm("dist", { recursive: true, force: true });
await execa("tsc", { stdio: "inherit" });
await chmod("dist/cli/main.js", 0o755);
