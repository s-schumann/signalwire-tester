import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

test("Importing the server for a review or test does not load local credentials", () => {
  const fixture = mkdtempSync(join(tmpdir(), "signalwire-import-"));
  try {
    cpSync(new URL("../src/", import.meta.url), join(fixture, "src"), { recursive: true });
    writeFileSync(join(fixture, "package.json"), '{"type":"module"}');
    writeFileSync(join(fixture, ".env"), "SIGNALWIRE_TOKEN=fixture-secret\n");
    const env = { ...process.env };
    delete env.SIGNALWIRE_TOKEN;
    const url = pathToFileURL(join(fixture, "src/server.js")).href;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e",
      `await import(${JSON.stringify(url)}); if (process.env.SIGNALWIRE_TOKEN !== undefined) process.exit(1);`,
    ], { env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
