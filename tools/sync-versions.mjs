import { readFileSync, writeFileSync } from "node:fs";

const PLUGIN_MANIFEST = "plugin/.claude-plugin/plugin.json";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const manifest = JSON.parse(readFileSync(PLUGIN_MANIFEST, "utf8"));
if (manifest.version !== pkg.version) {
  manifest.version = pkg.version;
  writeFileSync(PLUGIN_MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`synced ${PLUGIN_MANIFEST} to ${pkg.version}`);
}
