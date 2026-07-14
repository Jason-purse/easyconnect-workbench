# EasyConnect Workbench VPN-only Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Subagents are not authorized for this task; execute inline with the review gates below. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn EasyConnect Workbench into a focused macOS utility for EasyConnect auto-login and keepalive, with a compact single-screen status center and no build/release platform code.

**Architecture:** Keep `VpnService`, `VpnMaintainer`, `vpn-autostart`, the internal EasyConnect bridge, tray lifecycle, and main-process ownership intact. Remove the platform aggregation vertical slice end-to-end, add a small pure renderer view-state module, then rebuild the renderer around overview/activity views and a settings drawer. Use static contract tests plus pure unit tests before visual Playwright and packaged-app verification.

**Tech Stack:** Electron 35, Node.js 24.14.0, ESM JavaScript, Node test runner, Tailwind CSS 4, Lucide 1.24.0 UMD assets, Playwright CLI, GitNexus.

## Global Constraints

- Work only in `/Users/jasonj/software/develop-tools/ai-workspace/easyconnect-workbench/.worktrees/easyconnect-vpn-only` on `refactor/easyconnect-vpn-only`.
- Keep `/Users/jasonj/software/develop-tools/ai-workspace/easyconnect-workbench` unchanged at `main@e385631d4cc9d3d0501051d9607a7df69b831508`.
- Do not push; local commits only.
- Product scope is EasyConnect auto-login and keepalive. Build, release, publish, platform credentials, and platform APIs are out of scope.
- Preserve quiet hours `18:30-09:00`; renderer startup must not bypass `maybeStartMaintainerAutoStart()`.
- Do not change `src/easyconnect-bridge/` or VPN recovery semantics unless a failing regression test proves it is necessary.
- `collectConfig` is GitNexus HIGH risk with 12 direct callers. Update every retained caller and run renderer, service, maintainer, and smoke tests.
- `mergeConfig` is GitNexus HIGH risk because it owns `ConfigStore.load()` and `ConfigStore.save()`. Add old-config migration coverage before removing `portals`.
- Run GitNexus upstream impact before changing each named function and `gitnexus_detect_changes({scope:"staged"})` before every commit.
- Use test-first RED/GREEN cycles for product boundary, config migration, view state, and renderer contract.
- Use Lucide icons; do not draw custom SVG icons.
- No gradients, decorative blobs, card walls, negative letter spacing, viewport-scaled type, or border radii above `8px`.
- Close every browser session, static server, visual companion, and temporary port started during QA.

---

## File Map

### Create

- `test/product-boundary.test.mjs`: proves platform code and runtime identifiers are gone.
- `src/renderer/view-state.js`: pure connection and maintainer presentation model.
- `test/renderer-view-state.test.mjs`: state-model unit tests.
- `test/renderer-contract.test.mjs`: semantic DOM and visual-rule contract.

### Modify

- `package.json`, `package-lock.json`: test list and Lucide dependency.
- `src/services/config-store.js`, `test/config-store.test.mjs`: remove `portals` while safely loading old config.
- `src/main.js`: remove platform imports/IPC and update BrowserWindow size/background.
- `src/preload.cjs`: remove platform methods.
- `src/renderer/index.html`: replace sidebar/dashboard/platform pages with overview/activity/settings.
- `src/renderer/app.js`: remove platform actions and drive the new UI.
- `src/renderer/tailwind.css`, `src/renderer/styles.css`: implement the restrained visual system.
- `scripts/package-macos.mjs`: package the Lucide UMD asset used by the renderer.
- `README.md`: document the VPN-only product and current commands.
- `docs/superpowers/specs/2026-03-18-workbench-v1-design.md`: mark the old broad workbench design superseded.

### Delete

- `src/services/platform-api-client.js`
- `test/platform-api-client.test.mjs`
- `scripts/capture-platform-api.mjs`
- `docs/ui/easyconnect-workbench-production-prototype.html`

---

### Task 1: Remove The Platform Vertical Slice

**Files:**

- Create: `test/product-boundary.test.mjs`
- Modify: `package.json`
- Modify: `src/services/config-store.js`
- Modify: `test/config-store.test.mjs`
- Modify: `src/main.js`
- Modify: `src/preload.cjs`
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/app.js`
- Delete: `src/services/platform-api-client.js`
- Delete: `test/platform-api-client.test.mjs`
- Delete: `scripts/capture-platform-api.mjs`
- Delete: `docs/ui/easyconnect-workbench-production-prototype.html`

**Interfaces:**

- Consumes: `ConfigStore.load(): Promise<{app: AppConfig, vpn: VpnConfig}>`, existing VPN IPC methods, existing renderer actions.
- Produces: a runtime tree with only `app` and `vpn` configuration and no `platform:*` IPC surface.

- [ ] **Step 1: Add the failing product-boundary test**

Create `test/product-boundary.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";

const runtimeFiles = [
  "src/main.js",
  "src/preload.cjs",
  "src/renderer/app.js",
  "src/renderer/index.html",
  "src/services/config-store.js",
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
```

- [ ] **Step 2: Add old-config migration assertions**

Update the `node:fs/promises` import in `test/config-store.test.mjs` to include `writeFile`, replace the platform assertions in the first test with:

```js
assert.equal(Object.hasOwn(DEFAULT_CONFIG, "portals"), false);
```

Add this test:

```js
test("ConfigStore ignores legacy platform credentials when loading old config", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "easyconnect-workbench-config-"));

  try {
    await writeFile(
      path.join(tempDir, "config.json"),
      JSON.stringify({
        app: { launchAtLogin: true },
        vpn: { username: "demo-user", gateways: [{ host: "203.0.113.10", port: 9898 }] },
        portals: {
          build: { username: "legacy-build", password: "legacy-secret" },
          release: { username: "legacy-release", password: "legacy-secret" },
        },
      }),
    );

    const loaded = await new ConfigStore(tempDir).load();
    assert.equal(loaded.app.launchAtLogin, true);
    assert.equal(loaded.vpn.username, "demo-user");
    assert.equal(Object.hasOwn(loaded, "portals"), false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Run RED tests**

Run:

```bash
PATH=/Users/jasonj/.nvm/versions/node/v24.14.0/bin:$PATH node --test test/product-boundary.test.mjs test/config-store.test.mjs
```

Expected: failures identify `platform:*`, `build-portal`, `release-portal`, `portals`, existing platform files, and platform assertions in `DEFAULT_CONFIG`.

- [ ] **Step 4: Run required GitNexus impacts before edits**

Run these MCP calls and preserve the result in the task anchor:

```text
gitnexus_impact({repo:"easyconnect-workbench", target:"registerIpc", direction:"upstream"})
gitnexus_impact({repo:"easyconnect-workbench", target:"collectConfig", direction:"upstream", includeTests:true})
gitnexus_impact({repo:"easyconnect-workbench", target:"applyConfig", direction:"upstream", includeTests:true})
gitnexus_impact({repo:"easyconnect-workbench", target:"mergeConfig", direction:"upstream", includeTests:true})
```

Expected: `collectConfig` and `mergeConfig` remain HIGH risk; no unlisted direct caller is left unreviewed.

- [ ] **Step 5: Remove platform config while preserving VPN normalization**

In `src/services/config-store.js`, remove the `portals` block from `DEFAULT_CONFIG` and make the return shape of `mergeConfig` exactly:

```js
return {
  app: {
    ...base.app,
    ...(incoming?.app ?? {}),
    launchAtLogin: Boolean(incoming?.app?.launchAtLogin ?? base.app.launchAtLogin),
  },
  vpn: {
    ...base.vpn,
    ...(incoming?.vpn ?? {}),
    maintainerAutoStart: Boolean(incoming?.vpn?.maintainerAutoStart ?? base.vpn.maintainerAutoStart),
    maintainerIntervalSeconds:
      Number.parseInt(`${incoming?.vpn?.maintainerIntervalSeconds ?? base.vpn.maintainerIntervalSeconds ?? 300}`, 10) ||
      300,
    maintainerCycleTimeoutMs:
      Number.parseInt(`${incoming?.vpn?.maintainerCycleTimeoutMs ?? base.vpn.maintainerCycleTimeoutMs ?? 180000}`, 10) ||
      180000,
    maintainerQuietHoursEnabled: Boolean(
      incoming?.vpn?.maintainerQuietHoursEnabled ?? base.vpn.maintainerQuietHoursEnabled,
    ),
    maintainerQuietStart:
      `${incoming?.vpn?.maintainerQuietStart ?? base.vpn.maintainerQuietStart ?? "18:30"}`.trim() || "18:30",
    maintainerQuietEnd:
      `${incoming?.vpn?.maintainerQuietEnd ?? base.vpn.maintainerQuietEnd ?? "09:00"}`.trim() || "09:00",
    lastKnownGateway: normalizeGateway(
      shouldPreserveLearnedGateways
        ? base.vpn.lastKnownGateway
        : incoming?.vpn?.lastKnownGateway ?? base.vpn.lastKnownGateway,
    ),
    appExecutable: `${incoming?.vpn?.appExecutable ?? base.vpn.appExecutable ?? ""}`.trim(),
    gateways: shouldPreserveLearnedGateways
      ? baseGateways
      : normalizeGateways(incoming?.vpn?.gateways ?? base.vpn.gateways),
  },
};
```

- [ ] **Step 6: Remove platform runtime surfaces**

Perform these exact changes:

- remove every import from `./services/platform-api-client.js` in `src/main.js`;
- remove the `platform:build-overview` and `platform:release-overview` handlers from `registerIpc()`;
- remove `getBuildPlatformOverview` and `getReleasePlatformOverview` from `src/preload.cjs`;
- remove platform fields from `elements`, `collectConfig()`, `applyConfig()`, page metadata, event binding, list helpers, validation helpers, and refresh functions in `src/renderer/app.js`;
- remove the `Adapters` navigation group and both platform sections from `src/renderer/index.html`;
- delete the four files listed above;
- add `test/product-boundary.test.mjs` to `package.json` and remove `test/platform-api-client.test.mjs`.

- [ ] **Step 7: Run GREEN tests and the affected suite**

Run:

```bash
PATH=/Users/jasonj/.nvm/versions/node/v24.14.0/bin:$PATH node --test test/product-boundary.test.mjs test/config-store.test.mjs test/vpn-render-config.test.mjs test/vpn-maintainer.test.mjs test/vpn-service.test.mjs
PATH=/Users/jasonj/.nvm/versions/node/v24.14.0/bin:$PATH npm test
```

Expected: all targeted tests pass; full suite passes with platform tests removed and product-boundary tests included.

- [ ] **Step 8: Review and commit**

Run:

```bash
git diff --check
git diff --stat
git status --short
```

Then run `gitnexus_detect_changes({repo:"easyconnect-workbench", scope:"staged"})` after staging. Commit:

```bash
git add package.json src/main.js src/preload.cjs src/renderer/app.js src/renderer/index.html src/services/config-store.js test/config-store.test.mjs test/product-boundary.test.mjs
git add -u src/services/platform-api-client.js test/platform-api-client.test.mjs scripts/capture-platform-api.mjs docs/ui/easyconnect-workbench-production-prototype.html
git commit -m "refactor: remove platform aggregation"
```

---

### Task 2: Add A Tested Renderer View Model

**Files:**

- Create: `src/renderer/view-state.js`
- Create: `test/renderer-view-state.test.mjs`
- Modify: `package.json`

**Interfaces:**

- Consumes: `{status, environmentInfo, maintainerStatus}` from `vpn:snapshot` and `vpn:maintainer-status`.
- Produces: `deriveConnectionView(input): ConnectionView` and `deriveMaintainerView(input): MaintainerView` for DOM rendering.

- [ ] **Step 1: Write the failing view-state tests**

Create `test/renderer-view-state.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";

import { deriveConnectionView, deriveMaintainerView } from "../src/renderer/view-state.js";

test("online state exposes refresh as the single primary action", () => {
  assert.deepEqual(
    deriveConnectionView({
      status: { loginStatus: { status: "1" } },
      environmentInfo: { appExecutableExists: true },
      maintainerStatus: { running: true },
    }),
    {
      tone: "online",
      label: "已连接",
      title: "连接受到保护",
      primaryAction: "refresh",
      primaryLabel: "立即检查",
    },
  );
});

test("offline state exposes recovery", () => {
  const view = deriveConnectionView({
    status: { loginStatus: { status: "3" } },
    environmentInfo: { appExecutableExists: true },
    maintainerStatus: { running: false },
  });
  assert.equal(view.tone, "offline");
  assert.equal(view.primaryAction, "recover");
  assert.equal(view.primaryLabel, "立即连接");
});

test("missing official client sends the user to settings", () => {
  const view = deriveConnectionView({
    status: {},
    environmentInfo: { appExecutableExists: false },
    maintainerStatus: { running: false },
  });
  assert.equal(view.tone, "error");
  assert.equal(view.primaryAction, "open-settings");
  assert.equal(view.primaryLabel, "检查设置");
});

test("quiet hours are visible without enabling automatic recovery", () => {
  const view = deriveConnectionView({
    status: {},
    environmentInfo: { appExecutableExists: true },
    maintainerStatus: {
      running: false,
      lastEvent: { result: { action: "keepalive-paused-quiet-hours" } },
    },
  });
  assert.equal(view.tone, "quiet");
  assert.equal(view.primaryAction, "refresh");
  assert.equal(view.primaryLabel, "立即检查");
});

test("maintainer view distinguishes running, quiet, and stopped", () => {
  assert.equal(deriveMaintainerView({ maintainerStatus: { running: true } }).state, "running");
  assert.equal(
    deriveMaintainerView({
      maintainerStatus: { lastEvent: { result: { action: "keepalive-paused-quiet-hours" } } },
    }).state,
    "quiet",
  );
  assert.equal(
    deriveMaintainerView({
      maintainerStatus: { lastEvent: { result: { action: "keepalive-paused-quiet-hours" } } },
    }).action,
    null,
  );
  assert.equal(deriveMaintainerView({ maintainerStatus: { running: false } }).state, "stopped");
});
```

- [ ] **Step 2: Run RED test**

Run:

```bash
PATH=/Users/jasonj/.nvm/versions/node/v24.14.0/bin:$PATH node --test test/renderer-view-state.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/renderer/view-state.js`.

- [ ] **Step 3: Implement the pure view model**

Create `src/renderer/view-state.js`:

```js
function getLastAction(maintainerStatus = {}) {
  return (
    maintainerStatus?.lastEvent?.result?.action ??
    maintainerStatus?.lastEvent?.action ??
    maintainerStatus?.lastResult?.action ??
    null
  );
}

function isQuietHours(maintainerStatus) {
  return getLastAction(maintainerStatus) === "keepalive-paused-quiet-hours";
}

export function deriveConnectionView({ status = {}, environmentInfo = {}, maintainerStatus = {} } = {}) {
  if (!environmentInfo.appExecutableExists) {
    return {
      tone: "error",
      label: "客户端未就绪",
      title: "找不到 EasyConnect",
      primaryAction: "open-settings",
      primaryLabel: "检查设置",
    };
  }

  if (status.loginStatus?.status === "1") {
    return {
      tone: "online",
      label: "已连接",
      title: "连接受到保护",
      primaryAction: "refresh",
      primaryLabel: "立即检查",
    };
  }

  if (isQuietHours(maintainerStatus)) {
    return {
      tone: "quiet",
      label: "静默时段",
      title: "自动恢复已暂停",
      primaryAction: "refresh",
      primaryLabel: "立即检查",
    };
  }

  return {
    tone: "offline",
    label: "未连接",
    title: "连接需要恢复",
    primaryAction: "recover",
    primaryLabel: "立即连接",
  };
}

export function deriveMaintainerView({ config = {}, maintainerStatus = {} } = {}) {
  if (maintainerStatus.running) {
    return {
      state: "running",
      label: "运行中",
      action: "stop",
      actionLabel: "停止守护",
      intervalSeconds: Number(config?.vpn?.maintainerIntervalSeconds ?? 300),
    };
  }

  if (isQuietHours(maintainerStatus)) {
    return {
      state: "quiet",
      label: "静默时段",
      action: null,
      actionLabel: "静默时段后恢复",
      intervalSeconds: Number(config?.vpn?.maintainerIntervalSeconds ?? 300),
    };
  }

  return {
    state: "stopped",
    label: "已停止",
    action: "start",
    actionLabel: "启动守护",
    intervalSeconds: Number(config?.vpn?.maintainerIntervalSeconds ?? 300),
  };
}
```

- [ ] **Step 4: Run GREEN tests**

Run:

```bash
PATH=/Users/jasonj/.nvm/versions/node/v24.14.0/bin:$PATH node --test test/renderer-view-state.test.mjs
PATH=/Users/jasonj/.nvm/versions/node/v24.14.0/bin:$PATH npm test
```

Expected: view-state tests and the full suite pass.

- [ ] **Step 5: Add the test to npm and commit**

Add `test/renderer-view-state.test.mjs` to `package.json`, stage, run staged GitNexus detection, then commit:

```bash
git add package.json src/renderer/view-state.js test/renderer-view-state.test.mjs
git commit -m "test: define vpn renderer state model"
```

---

### Task 3: Rebuild The Renderer Around Overview, Activity, And Settings

**Files:**

- Create: `test/renderer-contract.test.mjs`
- Modify: `package.json`
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/app.js`

**Interfaces:**

- Consumes: `deriveConnectionView()`, `deriveMaintainerView()`, retained `window.workbench` VPN/config/directory methods.
- Produces: semantic DOM ids used by CSS and Playwright: `view-overview`, `view-activity`, `settings-drawer`, `connection-primary-action`, `maintainer-action`, and `action-notice`.

- [ ] **Step 1: Write the failing renderer contract**

Create `test/renderer-contract.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const requiredIds = [
  "view-overview",
  "view-activity",
  "settings-drawer",
  "open-settings",
  "close-settings",
  "connection-primary-action",
  "maintainer-action",
  "recent-activity-list",
  "activity-list",
  "action-notice",
  "vpn-quiet-hours-enabled",
  "vpn-quiet-start",
  "vpn-quiet-end",
];

test("renderer exposes the VPN-only status-center structure", async () => {
  const html = await readFile("src/renderer/index.html", "utf8");
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
});
```

- [ ] **Step 2: Run RED test**

Run:

```bash
PATH=/Users/jasonj/.nvm/versions/node/v24.14.0/bin:$PATH node --test test/renderer-contract.test.mjs
```

Expected: missing status-center ids and old sidebar/toast/autostart assertions fail.

- [ ] **Step 3: Run GitNexus impact gates**

Run:

```text
gitnexus_impact({repo:"easyconnect-workbench", target:"renderStatus", direction:"upstream", includeTests:true})
gitnexus_impact({repo:"easyconnect-workbench", target:"renderPage", direction:"upstream", includeTests:true})
gitnexus_impact({repo:"easyconnect-workbench", target:"init", direction:"upstream", includeTests:true})
```

Expected: direct callers remain within renderer refresh/recovery/init paths.

- [ ] **Step 4: Replace the renderer HTML with the semantic shell**

`src/renderer/index.html` must contain this exact top-level structure, with the existing VPN inputs and diagnostic `<pre>` nodes placed in the named regions:

```html
<div class="app-shell">
  <header class="app-toolbar">
    <div class="brand" aria-label="EasyConnect Workbench">
      <span class="brand__mark" aria-hidden="true"><i data-lucide="shield-check"></i></span>
      <span>EasyConnect Workbench</span>
    </div>
    <div class="view-switch" role="tablist" aria-label="工作区">
      <button id="show-overview" class="view-switch__button is-active" role="tab" data-view="overview">概览</button>
      <button id="show-activity" class="view-switch__button" role="tab" data-view="activity">活动</button>
    </div>
    <button id="open-settings" class="icon-button" type="button" aria-label="打开设置" title="设置">
      <i data-lucide="settings"></i>
    </button>
  </header>

  <div id="action-notice" class="action-notice is-hidden" role="status" aria-live="polite">
    <div><strong id="action-notice-title"></strong><span id="action-notice-detail"></span></div>
    <button id="dismiss-action-notice" class="icon-button" type="button" aria-label="关闭状态消息"><i data-lucide="x"></i></button>
  </div>

  <main class="app-content">
    <section id="view-overview" class="app-view is-active" data-view-panel="overview">
      <section class="connection-band" data-tone="idle">
        <div class="connection-band__status">
          <span id="connection-state" class="status-label">读取中</span>
          <h1 id="connection-title">正在检查连接</h1>
          <p id="connection-detail">等待本地运行状态。</p>
        </div>
        <button id="connection-primary-action" class="button button--primary" type="button">立即检查</button>
      </section>

      <section class="summary-strip" aria-label="连接摘要">
        <div><span>网关</span><strong id="metric-current-gateway">-</strong></div>
        <div><span>账号</span><strong id="metric-login-status">-</strong></div>
        <div><span>服务</span><strong id="metric-client-state">-</strong></div>
        <div><span>Session</span><strong id="metric-session-id">-</strong></div>
      </section>

      <div class="overview-grid">
        <section class="section-block" aria-labelledby="maintainer-heading">
          <div class="section-heading"><div><span>自动守护</span><h2 id="maintainer-heading">连接维护</h2></div><button id="maintainer-action" class="button button--secondary">启动守护</button></div>
          <dl class="detail-list"><div><dt>状态</dt><dd id="metric-maintainer-state">-</dd></div><div><dt>最近动作</dt><dd id="metric-last-action">-</dd></div><div><dt>上次错误</dt><dd id="metric-last-error">-</dd></div></dl>
        </section>
        <section class="section-block" aria-labelledby="health-heading">
          <div class="section-heading"><div><span>连接详情</span><h2 id="health-heading">运行状态</h2></div></div>
          <dl class="detail-list"><div><dt>官方界面</dt><dd id="metric-official-ui">-</dd></div><div><dt>首选网关</dt><dd id="metric-preferred-gateway">-</dd></div><div><dt>允许网关</dt><dd id="metric-allowed-gateways">-</dd></div></dl>
        </section>
      </div>

      <section class="activity-preview"><div class="section-heading"><div><span>最近活动</span><h2>状态变化</h2></div><button id="show-all-activity" class="text-button">查看全部</button></div><ol id="recent-activity-list" class="activity-list"></ol></section>
    </section>

    <section id="view-activity" class="app-view" data-view-panel="activity">
      <div class="page-heading"><div><span>活动</span><h1>连接记录</h1></div><button id="clear-activity" class="text-button">清空当前记录</button></div>
      <ol id="activity-list" class="activity-list activity-list--full"></ol>
      <details class="diagnostics"><summary>高级诊断</summary><div class="diagnostics__body"><div class="diagnostic-actions"><button id="repair-official-ui" class="button">修复官方界面</button><button id="launch-client" class="button">打开官方客户端</button><button id="probe-recovery" class="button">探测恢复链路</button><button id="debug-targets" class="button">查看调试目标</button></div><pre id="vpn-status" class="console-block"></pre><pre id="maintainer-status" class="console-block"></pre><pre id="recovery-plan" class="console-block"></pre><pre id="recovery-probe" class="console-block"></pre></div></details>
    </section>
  </main>
</div>

<div id="settings-backdrop" class="drawer-backdrop is-hidden"></div>
<aside id="settings-drawer" class="settings-drawer" aria-hidden="true" aria-labelledby="settings-title">
  <div class="settings-drawer__header"><h2 id="settings-title">设置</h2><button id="close-settings" class="icon-button" aria-label="关闭设置"><i data-lucide="x"></i></button></div>
  <form id="settings-form" class="settings-form">
    <section><h3>账号</h3><label class="field"><span>用户名</span><input id="vpn-username" autocomplete="username"></label><label class="field"><span>密码</span><span class="password-field"><input id="vpn-password" type="password" autocomplete="current-password"><button id="toggle-password" class="icon-button" type="button" aria-label="显示密码"><i data-lucide="eye"></i></button></span></label></section>
    <section><h3>网关</h3><label class="field"><span>允许网关</span><textarea id="vpn-gateways" rows="4"></textarea></label></section>
    <section><h3>自动守护</h3><label class="toggle-field"><input id="vpn-maintainer-autostart" type="checkbox"><span>启动应用时自动守护</span></label><label class="field"><span>检查间隔（秒）</span><input id="vpn-maintainer-interval" type="number" min="30" step="30"></label><label class="toggle-field"><input id="vpn-quiet-hours-enabled" type="checkbox"><span>启用静默时段</span></label><div class="time-grid"><label class="field"><span>开始</span><input id="vpn-quiet-start" type="time"></label><label class="field"><span>结束</span><input id="vpn-quiet-end" type="time"></label></div></section>
    <section><h3>系统</h3><label class="toggle-field"><input id="app-launch-at-login" type="checkbox"><span>登录 macOS 时启动</span></label></section>
    <details><summary>高级设置</summary><label class="field"><span>调试端口</span><input id="vpn-debug-port" type="number" min="1"></label><label class="field"><span>EasyConnect 路径</span><input id="vpn-app-executable"></label><div class="directory-actions"><button id="open-logs" class="button" type="button">打开日志</button><button id="open-config-dir" class="button" type="button">打开配置目录</button></div></details>
    <div class="settings-drawer__footer"><button id="save-config" class="button button--primary" type="submit">保存设置</button></div>
  </form>
</aside>
```

- [ ] **Step 5: Rewrite renderer behavior against the new DOM**

In `src/renderer/app.js`:

- import `deriveConnectionView` and `deriveMaintainerView`;
- replace `PAGE_META` with `currentView = "overview"` and `renderView(view)`;
- replace overlay toast state with `showActionNotice(title, detail, tone)` and `hideActionNotice()`;
- replace platform/list helpers with structured activity entries capped at 50;
- add settings drawer open/close, backdrop, Escape, and focus return;
- add password visibility toggle;
- make `connection-primary-action` dispatch `refreshStatus`, `recoverAndLogin`, or `openSettings` from the current view model;
- make `maintainer-action` dispatch `startMaintainer` or `stopMaintainer`; disable it when the maintainer view returns `action: null` during quiet hours;
- expose quiet-hours config in `collectConfig()` and `applyConfig()`;
- remove the renderer-owned autostart branch from `init()`; main process remains authoritative.

The retained config functions must be:

```js
function collectConfig() {
  return {
    app: {
      launchAtLogin: Boolean(elements.appLaunchAtLogin.checked),
    },
    vpn: {
      username: elements.vpnUsername.value.trim(),
      password: elements.vpnPassword.value,
      remoteDebugPort: Number.parseInt(elements.vpnDebugPort.value, 10) || 9222,
      maintainerIntervalSeconds: Number.parseInt(elements.vpnMaintainerInterval.value, 10) || 300,
      maintainerAutoStart: Boolean(elements.vpnMaintainerAutoStart.checked),
      maintainerQuietHoursEnabled: Boolean(elements.vpnQuietHoursEnabled.checked),
      maintainerQuietStart: elements.vpnQuietStart.value || "18:30",
      maintainerQuietEnd: elements.vpnQuietEnd.value || "09:00",
      appExecutable: elements.vpnAppExecutable.value.trim(),
      gateways: elements.vpnGateways.value
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [host, port] = line.split(":");
          return { host: (host ?? "").trim(), port: Number.parseInt((port ?? "").trim(), 10) || "" };
        }),
    },
  };
}

function applyConfig(config) {
  elements.appLaunchAtLogin.checked = Boolean(config.app?.launchAtLogin);
  elements.vpnUsername.value = config.vpn?.username ?? "";
  elements.vpnPassword.value = config.vpn?.password ?? "";
  elements.vpnDebugPort.value = String(config.vpn?.remoteDebugPort ?? 9222);
  elements.vpnMaintainerInterval.value = String(config.vpn?.maintainerIntervalSeconds ?? 300);
  elements.vpnMaintainerAutoStart.checked = Boolean(config.vpn?.maintainerAutoStart);
  elements.vpnQuietHoursEnabled.checked = Boolean(config.vpn?.maintainerQuietHoursEnabled);
  elements.vpnQuietStart.value = config.vpn?.maintainerQuietStart ?? "18:30";
  elements.vpnQuietEnd.value = config.vpn?.maintainerQuietEnd ?? "09:00";
  elements.vpnAppExecutable.value = config.vpn?.appExecutable ?? "";
  elements.vpnGateways.value = (config.vpn?.gateways ?? []).map((item) => `${item.host}:${item.port}`).join("\n");
}
```

- [ ] **Step 6: Run GREEN renderer and full tests**

Run:

```bash
PATH=/Users/jasonj/.nvm/versions/node/v24.14.0/bin:$PATH node --test test/renderer-contract.test.mjs test/renderer-view-state.test.mjs test/product-boundary.test.mjs
PATH=/Users/jasonj/.nvm/versions/node/v24.14.0/bin:$PATH npm test
```

Expected: renderer contract passes and all VPN tests remain green.

- [ ] **Step 7: Commit the functional renderer**

Add `test/renderer-contract.test.mjs` to `package.json`, stage, run GitNexus staged detection, and commit:

```bash
git add package.json src/renderer/index.html src/renderer/app.js test/renderer-contract.test.mjs
git commit -m "feat: rebuild vpn status center"
```

---

### Task 4: Implement The Visual System, Icons, And Window Shell

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `scripts/package-macos.mjs`
- Modify: `src/main.js`
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/app.js`
- Modify: `src/renderer/tailwind.css`
- Modify: `src/renderer/styles.css`
- Modify: `test/renderer-contract.test.mjs`

**Interfaces:**

- Consumes: Task 3 semantic ids and view state.
- Produces: packaged Lucide UMD asset, display-relative initial window bounds with a `900x640` design floor, and responsive screenshot artifacts.

- [ ] **Step 1: Extend the style contract before implementation**

Add to `test/renderer-contract.test.mjs`:

```js
test("visual source avoids disallowed decorative patterns", async () => {
  const css = await readFile("src/renderer/tailwind.css", "utf8");
  assert.doesNotMatch(css, /gradient/i);
  assert.doesNotMatch(css, /letter-spacing:\s*-/i);
  assert.doesNotMatch(css, /border-radius:\s*(?:[1-9][0-9]|[1-9][0-9]{2,})px/i);
  assert.match(css, /--color-online:/);
  assert.match(css, /--color-warning:/);
  assert.match(css, /--color-danger:/);
});
```

- [ ] **Step 2: Run RED visual contract**

Run:

```bash
PATH=/Users/jasonj/.nvm/versions/node/v24.14.0/bin:$PATH node --test test/renderer-contract.test.mjs
```

Expected: old CSS fails gradient, negative letter spacing, large radius, and state-token assertions.

- [ ] **Step 3: Install Lucide and package its UMD asset**

Run:

```bash
PATH=/Users/jasonj/.nvm/versions/node/v24.14.0/bin:$PATH npm install lucide@1.24.0 --save
```

Verify `node_modules/lucide/dist/umd/lucide.js` exists. In `scripts/package-macos.mjs`, add a helper that copies `lucide.js` and the Lucide license into `Resources/app/node_modules/lucide`, then call it from `copyAppPayload()`.

Add this script before `app.js` in `src/renderer/index.html`:

```html
<script defer src="../../node_modules/lucide/dist/umd/lucide.js"></script>
```

After DOM binding in `init()`, render icons with:

```js
window.lucide?.createIcons({
  attrs: {
    width: 18,
    height: 18,
    "stroke-width": 1.8,
    "aria-hidden": "true",
  },
});
```

- [ ] **Step 4: Replace Tailwind source with the approved tokens and layout**

Use these root tokens in `src/renderer/tailwind.css`:

```css
:root {
  color-scheme: light;
  --color-bg: #eef1ef;
  --color-surface: #ffffff;
  --color-surface-muted: #f6f8f7;
  --color-line: #d7ded9;
  --color-line-strong: #bdc8c1;
  --color-ink: #17211d;
  --color-ink-muted: #617069;
  --color-online: #1f7a50;
  --color-online-soft: #e8f4ed;
  --color-warning: #a86412;
  --color-warning-soft: #fbf1df;
  --color-danger: #b43c3c;
  --color-danger-soft: #f9e8e8;
  --color-action: #285d88;
  --shadow-drawer: 0 20px 56px rgba(23, 33, 29, 0.16);
  font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif;
}
```

Implement these stable layout rules:

```css
.app-shell { display: grid; grid-template-rows: auto auto minmax(0, 1fr); width: 100%; height: 100dvh; min-height: 0; overflow: hidden; background: var(--color-bg); color: var(--color-ink); }
.app-toolbar { position: sticky; top: 0; z-index: 20; display: grid; grid-template-columns: minmax(220px, 1fr) auto minmax(220px, 1fr); align-items: center; height: 58px; padding: 0 22px; border-bottom: 1px solid var(--color-line); background: rgba(255, 255, 255, 0.96); }
.app-content { width: 100%; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 24px; }
.app-view { width: min(100%, max(992px, 72vw)); margin: 0 auto; }
.connection-band { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: end; gap: 24px; padding: 26px 0 24px; border-bottom: 1px solid var(--color-line-strong); }
.connection-band h1 { margin: 8px 0 6px; font-family: "Avenir Next", -apple-system, sans-serif; font-size: 32px; line-height: 1.15; letter-spacing: 0; }
.summary-strip { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); border-bottom: 1px solid var(--color-line); }
.summary-strip > div { min-width: 0; padding: 18px 16px; border-right: 1px solid var(--color-line); }
.overview-grid { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(320px, 0.85fr); gap: 0; border-bottom: 1px solid var(--color-line); }
.section-block { min-width: 0; padding: 24px 0; }
.section-block + .section-block { padding-left: 24px; border-left: 1px solid var(--color-line); }
.settings-drawer { position: fixed; z-index: 40; top: 0; right: 0; width: min(420px, calc(100vw - 32px)); height: 100dvh; transform: translateX(100%); border-left: 1px solid var(--color-line); background: var(--color-surface); box-shadow: var(--shadow-drawer); transition: transform 180ms ease; }
.settings-drawer.is-open { transform: translateX(0); }
@media (max-width: 760px) { .app-toolbar { grid-template-columns: 1fr auto; } .view-switch { grid-column: 1 / -1; order: 3; } .overview-grid, .summary-strip { grid-template-columns: 1fr; } .section-block + .section-block { padding-left: 0; border-left: 0; border-top: 1px solid var(--color-line); } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; transition: none !important; animation: none !important; } }
```

All buttons, inputs, rows, notices, activity items, console blocks, tabs, drawer groups, focus states, and tone selectors must use `0`, `4px`, `6px`, or `8px` radii and fixed dimensions.

- [ ] **Step 5: Update BrowserWindow geometry**

After running `gitnexus_impact` for `createWindow`, calculate bounds from the display nearest the cursor. `window-geometry.js` applies `60%` work-area width, `80%` work-area height, a `900x640` design floor, work-area caps, centering, and a `1.2-1.6` aspect-ratio range before passing the result to `BrowserWindow`:

```js
...calculateInitialWindowBounds(display.workArea),
title: "EasyConnect Workbench",
backgroundColor: "#eef1ef",
```

- [ ] **Step 6: Build and run GREEN contract tests**

Run:

```bash
PATH=/Users/jasonj/.nvm/versions/node/v24.14.0/bin:$PATH npm run build:css
PATH=/Users/jasonj/.nvm/versions/node/v24.14.0/bin:$PATH node --test test/renderer-contract.test.mjs
PATH=/Users/jasonj/.nvm/versions/node/v24.14.0/bin:$PATH npm test
```

Expected: CSS builds, visual contract passes, and full suite passes.

- [ ] **Step 7: Run Playwright visual QA without Electron side effects**

Start a static server from the worktree root and track its session:

```bash
python3 -m http.server 8765 --bind 127.0.0.1
```

Open `about:blank` with the Playwright wrapper, add a `window.workbench` init script that returns an online snapshot, current config, maintainer running state, and empty recovery plan, then navigate to:

```text
http://127.0.0.1:8765/src/renderer/index.html
```

Use this complete preload stub before navigation:

```js
async (page) => {
  await page.addInitScript(() => {
    const config = {
      app: { launchAtLogin: true },
      vpn: {
        username: "demo-user",
        password: "demo-password",
        remoteDebugPort: 9222,
        maintainerAutoStart: true,
        maintainerIntervalSeconds: 300,
        maintainerQuietHoursEnabled: true,
        maintainerQuietStart: "18:30",
        maintainerQuietEnd: "09:00",
        lastKnownGateway: { host: "203.0.113.10", port: 9898 },
        appExecutable: "/Applications/EasyConnect.app/Contents/MacOS/EasyConnect",
        gateways: [{ host: "203.0.113.10", port: 9898 }],
      },
    };
    const status = {
      loginStatus: { status: "1" },
      activeSession: { sessionId: "preview-session-7f2a" },
      serviceState: { base: 18, l3vpn: 18, tcp: 43 },
      officialUi: { primaryKind: "service", hasBlockingVisibleTarget: false },
    };
    const environmentInfo = {
      appExecutableExists: true,
      appExecutable: config.vpn.appExecutable,
      logsDir: "/Users/demo/Library/Logs/easyconnect-workbench",
      bundleConfDir: "/Applications/EasyConnect.app/Contents/Resources/conf",
      gatewayCandidates: config.vpn.gateways,
    };
    let maintainerStatus = {
      running: true,
      gateway: config.vpn.lastKnownGateway,
      lastEvent: { ok: true, result: { action: "already-online", status } },
    };
    window.workbench = {
      getConfig: async () => config,
      saveConfig: async (nextConfig) => Object.assign(config, nextConfig),
      getVpnSnapshot: async () => ({ status, environmentInfo }),
      getVpnStatus: async () => status,
      getEnvironmentInfo: async () => environmentInfo,
      getRecoveryPlan: async () => ({ gatewayCandidates: config.vpn.gateways, fallback: "portal-debug" }),
      probeRecoveryPlan: async () => [],
      launchOfficialClient: async () => ({ ok: true, action: "reused-existing" }),
      recoverOfficialClient: async () => ({ ok: true, action: "recovered-user-mode" }),
      getDebugTargets: async () => [],
      portalLogin: async () => ({ ok: true }),
      recoverAndLogin: async () => ({ ok: true, action: "relogin-page-bridge", status }),
      repairOfficialUi: async () => ({ ok: true, action: "already-consistent" }),
      getMaintainerStatus: async () => maintainerStatus,
      startMaintainer: async () => {
        maintainerStatus = { ...maintainerStatus, running: true };
        return maintainerStatus;
      },
      stopMaintainer: async () => {
        maintainerStatus = { ...maintainerStatus, running: false };
        return maintainerStatus;
      },
      openLogsDir: async () => "",
      openConfigDir: async () => "",
    };
  });
  await page.goto("http://127.0.0.1:8765/src/renderer/index.html");
}
```

Capture:

```text
output/playwright/vpn-only-1152x864.png
output/playwright/vpn-only-900x720.png
output/playwright/vpn-only-900x640.png
output/playwright/vpn-only-720x760.png
output/playwright/vpn-only-settings.png
output/playwright/vpn-only-activity.png
```

For each viewport, verify:

- screenshot contains non-background pixels across toolbar and content;
- no horizontal scrollbar;
- no overlap or clipped labels;
- status band, overview grid, drawer, and activity view preserve stable dimensions;
- `1536x1152`、`1152x864`、`900x720` 的常规概览无需滚动，`900x640` 与 `720x760` 只允许主内容区按需滚动；
- browser console has no unexpected errors;
- overview/activity/settings/password/diagnostic interactions work.

Close the Playwright session and stop port 8765. Verify with `lsof -nP -iTCP:8765 -sTCP:LISTEN` and `playwright-cli list`.

- [ ] **Step 8: Package and commit the visual shell**

Run:

```bash
PATH=/Users/jasonj/.nvm/versions/node/v24.14.0/bin:$PATH npm run package:mac
PATH=/Users/jasonj/.nvm/versions/node/v24.14.0/bin:$PATH npm run smoke:packaged-app-lifecycle
```

Expected: package contains `Resources/app/node_modules/lucide/dist/umd/lucide.js`; lifecycle smoke passes.

Stage, run GitNexus staged detection, then commit:

```bash
git add package.json package-lock.json scripts/package-macos.mjs src/main.js src/renderer/index.html src/renderer/app.js src/renderer/tailwind.css src/renderer/styles.css test/renderer-contract.test.mjs
git commit -m "style: refine vpn workbench interface"
```

---

### Task 5: Align Documentation And Run Independent Review

**Files:**

- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-03-18-workbench-v1-design.md`
- Modify: source/test files only when review findings are proven.

**Interfaces:**

- Consumes: completed VPN-only application and the branch diff from `e385631`.
- Produces: accurate user documentation and a reviewed diff with no unresolved high-severity findings.

- [ ] **Step 1: Update documentation**

Rewrite README sections so the first paragraph and capability list say only:

- automatic login and recovery through the installed official EasyConnect client;
- keepalive with quiet hours;
- tray residency and clear connection status;
- local configuration, packaging, tests, and installed verification.

Remove platform, build, release, publish, adapter, and aggregation wording. Add this banner at the top of the old design document:

```markdown
> Superseded on 2026-07-10 by [EasyConnect Workbench VPN-only 重构设计](./2026-07-10-easyconnect-vpn-only-redesign.md). This file is retained only as historical context for the pre-refocus product.
```

- [ ] **Step 2: Run documentation and boundary checks**

Run:

```bash
rg -n -i 'build-portal|release-portal|platform:build|platform:release|构建站|发版站|发布平台' README.md src scripts package.json
PATH=/Users/jasonj/.nvm/versions/node/v24.14.0/bin:$PATH npm test
git diff --check
```

Expected: `rg` returns no product-runtime matches; tests and diff check pass.

- [ ] **Step 3: Commit documentation**

```bash
git add README.md docs/superpowers/specs/2026-03-18-workbench-v1-design.md
git commit -m "docs: align vpn-only product boundary"
```

- [ ] **Step 4: Run independent code review**

Use the local `claude` review skill/CLI against:

```text
git diff e385631d4cc9d3d0501051d9607a7df69b831508..HEAD
```

Review priorities:

1. VPN recovery or maintainer regressions;
2. quiet-hours bypass;
3. config migration or credential persistence errors;
4. removed IPC still referenced by renderer/preload/main;
5. Electron packaging path for Lucide;
6. UI accessibility, overflow, and action-state bugs;
7. missing or weak tests.

Record findings with severity and exact file/line references. Verify every finding in source or tests before changing code.

- [ ] **Step 5: Fix proven findings with targeted RED/GREEN tests**

For each proven behavior issue:

1. add or adjust a focused test;
2. run it and observe failure;
3. apply the smallest fix;
4. run targeted and full tests;
5. stage only the reviewed files;
6. run GitNexus staged detection;
7. commit with `fix: address vpn-only review findings`.

If no proven issue remains, do not create an empty review commit.

---

### Task 6: Package, Install, And Perform Controlled Recovery Acceptance

**Files:**

- Modify: none unless acceptance exposes a reproducible defect.
- Evidence: ignored `output/`, task anchor, installed app, process snapshots, and logs.

**Interfaces:**

- Consumes: packaged worktree application, existing local VPN configuration, and user authorization for controlled disconnect.
- Produces: code, visual, lifecycle, packaged, and real recovery evidence.

- [ ] **Step 1: Verify time and capture the live baseline**

Confirm local time is outside `18:30-09:00`. Record without exposing credentials:

```bash
date '+%Y-%m-%d %H:%M:%S %Z'
pgrep -afil 'EasyConnect Workbench|EasyConnect.app/Contents/MacOS/EasyConnect|CSClient|svpnservice'
shasum -a 256 "$HOME/Library/Application Support/easyconnect-workbench/config.json"
```

Capture a sanitized installed snapshot using the existing smoke/summary helpers. Do not print password, session token, cookie, or gateway handshake bodies.

- [ ] **Step 2: Run final source verification**

```bash
PATH=/Users/jasonj/.nvm/versions/node/v24.14.0/bin:$PATH npm ci
PATH=/Users/jasonj/.nvm/versions/node/v24.14.0/bin:$PATH npm run build:css
PATH=/Users/jasonj/.nvm/versions/node/v24.14.0/bin:$PATH npm test
PATH=/Users/jasonj/.nvm/versions/node/v24.14.0/bin:$PATH npm run smoke:app-lifecycle
PATH=/Users/jasonj/.nvm/versions/node/v24.14.0/bin:$PATH npm run smoke:app-hidden-start
PATH=/Users/jasonj/.nvm/versions/node/v24.14.0/bin:$PATH npm run package:mac
PATH=/Users/jasonj/.nvm/versions/node/v24.14.0/bin:$PATH npm run smoke:packaged-app-lifecycle
```

Expected: every command exits 0; no uncommitted generated CSS or lockfile drift remains.

- [ ] **Step 3: Run installed end-to-end verification**

Run:

```bash
PATH=/Users/jasonj/.nvm/versions/node/v24.14.0/bin:$PATH npm run verify:mvp-installed
```

Expected evidence:

- installed Workbench is replaced from the current package;
- app lifecycle and hidden start pass;
- controlled offline recovery observes `activeSession=null` before recovery;
- first recovery action is not `already-online`;
- a new online session is established;
- service state returns healthy values;
- invalid-gateway failure smoke does not pollute saved config;
- the background online cycle records a structured official UI outcome for status feedback without gating VPN health;
- hidden Workbench returns to idle CPU;
- final config hash/allowed gateway semantics remain valid.

Renderer usability is accepted separately by the headless browser QA, while Electron-only behavior is covered by source and packaged lifecycle/hidden-start smokes. Strict foreground repair of the third-party EasyConnect native window remains an opt-in manual diagnostic and is not part of `verify:mvp-installed`.

If this command fails, stop repeated destructive attempts. Restore connectivity using the last verified allowed gateway and record the exact failing command, phase, and log handle.

- [ ] **Step 4: Run final graph and git audits**

Run:

```text
gitnexus_detect_changes({repo:"easyconnect-workbench", scope:"compare", base_ref:"e385631d4cc9d3d0501051d9607a7df69b831508"})
```

Then:

```bash
git diff --check e385631d4cc9d3d0501051d9607a7df69b831508..HEAD
git diff --name-status e385631d4cc9d3d0501051d9607a7df69b831508..HEAD
git log --oneline --decorate e385631d4cc9d3d0501051d9607a7df69b831508..HEAD
git status --short --branch
git -C /Users/jasonj/software/develop-tools/ai-workspace/easyconnect-workbench status --short --branch
git -C /Users/jasonj/software/develop-tools/ai-workspace/easyconnect-workbench rev-parse HEAD
```

Expected:

- worktree branch is clean;
- original checkout is clean and still equals `e385631d4cc9d3d0501051d9607a7df69b831508`;
- branch diff contains only VPN-only scope, UI, tests, packaging support, and documentation;
- no remote was added or pushed.

- [ ] **Step 5: Close resources and update task state**

Close browser sessions, static servers, ports, file watchers, and temporary profiles. Update `docs/project-brief/task-records/T12-vpn-only-product-refocus.md` with:

- exact commit list;
- review findings and resolutions;
- test/build/package/installed acceptance results;
- controlled recovery evidence handles;
- final resource cleanup result;
- final status `done` only when every required check passes.
