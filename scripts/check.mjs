import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
let checked = 0;
for (const directory of ["src", "test", "scripts"]) {
  for (const entry of readdirSync(new URL(`${directory}/`, root), { withFileTypes: true })) {
    if (!entry.isFile() || !/\.(?:js|mjs)$/.test(entry.name)) continue;
    const path = fileURLToPath(new URL(`${directory}/${entry.name}`, root));
    const result = spawnSync(process.execPath, ["--check", path], { stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
    checked++;
  }
}
console.log(`Syntax checked ${checked} source, test, and verification files.`);
