import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const requiredIds = [
  "view-overview",
  "view-activity",
  "settings-drawer",
  "settings-feedback",
  "open-settings",
  "close-settings",
  "connection-primary-action",
  "maintainer-action",
  "metric-maintainer-interval",
  "metric-maintainer-last-check",
  "metric-maintainer-next-check",
  "recent-activity-list",
  "activity-list",
  "action-notice",
  "vpn-quiet-hours-enabled",
  "vpn-quiet-start",
  "vpn-quiet-end",
];

test("renderer exposes the VPN-only status-center structure", async () => {
  const html = await readFile("src/renderer/index.html", "utf8");
  assert.match(html, /<link[^>]+rel=["']icon["'][^>]+href=["']data:/, "missing inline favicon");
  for (const id of requiredIds) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `missing #${id}`);
  }
  assert.doesNotMatch(html, /app-sidebar|build-portal|release-portal|Adapters/);
});

test("renderer behavior has no toast overlay or renderer-owned autostart", async () => {
  const source = await readFile("src/renderer/app.js", "utf8");
  assert.doesNotMatch(source, /showToast|toastTimer/);
  assert.doesNotMatch(source, /自动守护自启动/);
  assert.match(source, /deriveConnectionView/);
  assert.match(source, /deriveMaintainerView/);
  assert.match(source, /removeAttribute\(["']inert["']\)/);
  assert.match(source, /setAttribute\(["']inert["']/);
  assert.match(source, /appShell.*setAttribute\(["']inert["']/s);
  assert.match(source, /trapSettingsFocus/);
  assert.match(source, /sanitizeVpnStatusForDisplay/);
  assert.match(source, /deriveMaintainerActivity/);
  assert.match(source, /currentConnectionAction === null/);
});

test("settings drawer is modal and keeps save feedback inside the drawer", async () => {
  const html = await readFile("src/renderer/index.html", "utf8");
  const source = await readFile("src/renderer/app.js", "utf8");
  assert.match(html, /id=["']settings-drawer["'][^>]+role=["']dialog["'][^>]+aria-modal=["']true["']/s);
  assert.match(html, /id=["']settings-feedback["'][^>]+role=["']status["']/s);

  const saveConfigSource = source.match(/async function saveConfig\(\)[\s\S]*?\n}\n\nasync function launchClient/)?.[0] ?? "";
  assert.match(saveConfigSource, /showSettingsFeedback/);
  assert.doesNotMatch(saveConfigSource, /closeSettings/);
});

test("project owns an executable browser keyboard QA command", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal(
    packageJson.scripts?.["qa:renderer-keyboard"],
    "node scripts/qa-renderer-keyboard.mjs",
  );

  const source = await readFile("scripts/qa-renderer-keyboard.mjs", "utf8");
  assert.doesNotMatch(source, /\/Users\/jasonj\/\.codex\/bin\/playwright-cli/);
  assert.doesNotMatch(source, /v24\.14\.0/);
  assert.match(source, /PLAYWRIGHT_CLI/);
  assert.match(source, /CODEX_HOME/);
  assert.match(source, /homedir\(\)/);
  assert.match(source, /dirname\(process\.execPath\)/);
  assert.match(source, /easyconnect-vpn-only-keyboard-qa/);
  assert.match(source, /page\.keyboard\.press/);
  assert.match(source, /server\.close/);
});

test("tray start and dynamic diagnostics cannot bypass shared guards", async () => {
  const mainSource = await readFile("src/main.js", "utf8");
  const rendererSource = await readFile("src/renderer/app.js", "utf8");

  const trayStartSource =
    mainSource.match(/async function startMaintainerFromTray\(\)[\s\S]*?\n}\n\nfunction updateTrayMenu/)?.[0] ?? "";
  const trayUpdateSource =
    mainSource.match(/function updateTrayMenu\(\)[\s\S]*?\n}\n\nfunction startTray/)?.[0] ?? "";

  assert.match(trayStartSource, /startMaintainerWithQuietHoursGuard/);
  assert.match(trayUpdateSource, /getMaintainerStatusWithQuietHours/);
  assert.match(rendererSource, /function renderDiagnosticResult/);
  assert.match(rendererSource, /sanitizeDiagnosticValueForDisplay/);
  assert.doesNotMatch(
    rendererSource,
    /setNodeText\(elements\.diagnosticResult,\s*safeStringify\(result\)\)/,
  );
});

test("renderer routes every window IPC call through the focused action runner", async () => {
  const source = await readFile("src/renderer/app.js", "utf8");
  assert.match(source, /runIpcAction/);
  assert.doesNotMatch(source, /function withTimeout/);
  for (const operation of [
    "getVpnSnapshot",
    "getConfig",
    "getMaintainerStatus",
    "getRecoveryPlan",
    "saveConfig",
    "launchOfficialClient",
    "recoverAndLogin",
    "repairOfficialUi",
    "getDebugTargets",
    "probeRecoveryPlan",
    "startMaintainer",
    "stopMaintainer",
    "openLogsDir",
    "openConfigDir",
  ]) {
    assert.match(source, new RegExp(`runIpcAction\\([\\s\\S]{0,260}window\\.workbench\\.${operation}`), operation);
  }
});

test("visual source avoids disallowed decorative patterns", async () => {
  const css = await readFile("src/renderer/tailwind.css", "utf8");
  assert.doesNotMatch(css, /gradient/i);
  assert.doesNotMatch(css, /letter-spacing:\s*-/i);
  assert.doesNotMatch(css, /border-radius:\s*(?:[1-9][0-9]|[1-9][0-9]{2,})px/i);
  assert.match(css, /--color-online:/);
  assert.match(css, /--color-warning:/);
  assert.match(css, /--color-danger:/);
});
