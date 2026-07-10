import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";

const runtimeFiles = [
  "src/main.js",
  "src/preload.cjs",
  "src/renderer/app.js",
  "src/renderer/index.html",
  "src/services/config-store.js",
  "src/services/vpn-render-config.js",
];

const forbiddenRuntimePatterns = [
  /platform:/,
  /build-portal/,
  /release-portal/,
  /getBuildPlatformOverview/,
  /getReleasePlatformOverview/,
  /portals\s*:/,
];

test("runtime product surface contains no build or release platform integration", async () => {
  for (const file of runtimeFiles) {
    const source = await readFile(file, "utf8");
    for (const pattern of forbiddenRuntimePatterns) {
      assert.doesNotMatch(source, pattern, `${file} still matches ${pattern}`);
    }
  }
});

test("platform implementation artifacts are removed", async () => {
  const removedFiles = [
    "src/services/platform-api-client.js",
    "test/platform-api-client.test.mjs",
    "scripts/capture-platform-api.mjs",
    "docs/ui/easyconnect-workbench-production-prototype.html",
  ];

  for (const file of removedFiles) {
    await assert.rejects(access(file), (error) => error?.code === "ENOENT", `${file} must not exist`);
  }
});

test("npm test includes the VPN-only product boundary and excludes platform tests", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  assert.match(packageJson.scripts.test, /test\/product-boundary\.test\.mjs/);
  assert.doesNotMatch(packageJson.scripts.test, /platform-api-client/);
});
