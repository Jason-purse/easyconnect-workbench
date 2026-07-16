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

test("agent CLI stays a thin installed Workbench client", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  const mainSource = await readFile("src/main.js", "utf8");
  const packageSource = await readFile("scripts/package-macos.mjs", "utf8");
  const wrapperSource = await readFile("bin/easyconnect-vpn", "utf8");

  assert.equal(packageJson.scripts["install:cli"], "node scripts/install-cli.mjs");
  assert.match(mainSource, /createAgentCommandServer/);
  assert.match(mainSource, /createRetryableAgentCommandServerStarter/);
  assert.match(mainSource, /createVpnAgentController/);
  assert.match(mainSource, /agentCommandServerStarter\.start\(\)/);
  assert.match(mainSource, /agentCommandServerStarter\?\.stopAccepting\(\)/);
  assert.match(mainSource, /isQuitting\s*&&\s*shouldStartHidden\(argv\)/);
  assert.match(mainSource, /scheduleHiddenRelaunch\(\)/);
  assert.match(
    mainSource,
    /if \(shouldStartHidden\(argv\)\) \{[\s\S]{0,160}retryAgentCommandServerStart\(\)/,
  );
  assert.match(packageSource, /bin["'],\s*["']easyconnect-vpn/);
  assert.match(packageSource, /chmod\(.*0o755/);
  assert.match(wrapperSource, /ELECTRON_RUN_AS_NODE=1/);
  assert.match(wrapperSource, /export EASYCONNECT_WORKBENCH_APP_PATH=/);
  assert.match(wrapperSource, /Resources\/app\/src\/cli\/easyconnect-vpn\.js/);
  assert.doesNotMatch(wrapperSource, /password|username/i);
});

test("installed verification replaces the app bundle instead of overlaying stale files", async () => {
  const source = await readFile("scripts/verify-mvp-installed.mjs", "utf8");
  const stageCopy = source.indexOf('await run("/usr/bin/ditto", [distApp, stagedApp])');
  const removeInstalled = source.indexOf("await rm(installedApp, { recursive: true, force: true })");
  const activateStage = source.indexOf("await rename(stagedApp, installedApp)");

  assert.notEqual(stageCopy, -1, "installer must copy the package into a staging bundle");
  assert.notEqual(removeInstalled, -1, "installer must remove the previous bundle and its stale files");
  assert.notEqual(activateStage, -1, "installer must activate the staged bundle with rename");
  assert.ok(stageCopy < removeInstalled && removeInstalled < activateStage);
  assert.doesNotMatch(source, /run\("\/usr\/bin\/ditto", \[distApp, installedApp\]\)/);
});

test("VPN smoke verification explicitly bypasses quiet hours without changing production defaults", async () => {
  const verifierSource = await readFile("scripts/verify-mvp-installed.mjs", "utf8");
  const mainSource = await readFile("src/main.js", "utf8");
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));

  for (const scriptName of [
    "smoke:vpn-autostart",
    "smoke:vpn-keepalive",
    "smoke:vpn-offline-recovery",
    "smoke:vpn-failure-state",
    "smoke:packaged-vpn-autostart",
    "smoke:packaged-vpn-offline-recovery",
    "smoke:packaged-vpn-failure-state",
  ]) {
    assert.match(packageJson.scripts[scriptName], /--smoke-ignore-quiet-hours/, scriptName);
  }
  for (const smokeFlag of [
    "--smoke-vpn-autostart",
    "--smoke-vpn-keepalive",
    "--smoke-vpn-offline-recovery",
    "--smoke-vpn-failure-state",
  ]) {
    assert.match(
      verifierSource,
      new RegExp(`${smokeFlag}[\\s\\S]{0,180}--smoke-ignore-quiet-hours`),
      smokeFlag,
    );
  }
  assert.match(
    mainSource,
    /ignoreQuietHours:\s*hasArg\("--smoke-ignore-quiet-hours"\)/,
  );
  assert.match(mainSource, /createVpnSmokeConfig/);
});

test("installed MVP verification keeps native official UI repair opt-in", async () => {
  const verifierSource = await readFile("scripts/verify-mvp-installed.mjs", "utf8");
  const mainSource = await readFile("src/main.js", "utf8");
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));

  assert.doesNotMatch(verifierSource, /--smoke-official-ui-repair/);
  assert.match(packageJson.scripts["smoke:official-ui-repair"], /--smoke-official-ui-repair/);
  assert.match(
    packageJson.scripts["smoke:packaged-official-ui-repair"],
    /--smoke-official-ui-repair/,
  );
  assert.match(
    mainSource,
    /requireExercise:\s*hasArg\("--smoke-require-ui-repair"\)/,
  );
});

test("failure-state cleanup restore has an explicit smoke-only timeout budget", async () => {
  const verifierSource = await readFile("scripts/verify-mvp-installed.mjs", "utf8");
  const mainSource = await readFile("src/main.js", "utf8");

  assert.match(
    verifierSource,
    /--smoke-vpn-failure-state[\s\S]{0,240}--smoke-restore-timeout-ms=300000/,
  );
  assert.match(
    mainSource,
    /restoreTimeoutMs\s*=\s*getNumberArg\("--smoke-restore-timeout-ms",\s*timeoutMs\)/,
  );
  assert.match(mainSource, /maintainerCycleTimeoutMs:\s*restoreTimeoutMs/);
  assert.match(mainSource, /waitForMaintainerCycle\(1,\s*restoreTimeoutMs\)/);
});
