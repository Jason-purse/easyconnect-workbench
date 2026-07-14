import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { delimiter, dirname, extname, join, resolve, sep } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT_DIR = fileURLToPath(new URL("../", import.meta.url));
const SESSION_NAME = "easyconnect-vpn-only-keyboard-qa";
const NODE_BIN_DIR = dirname(process.execPath);
const SCREENSHOT_DIR = join(ROOT_DIR, "output", "playwright");

async function isExecutable(filePath) {
  if (!filePath) {
    return false;
  }

  try {
    await access(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolvePlaywrightCli(environment = process.env) {
  const configuredCandidates = [
    environment.PLAYWRIGHT_CLI,
    environment.CODEX_HOME ? join(environment.CODEX_HOME, "bin", "playwright-cli") : null,
    join(homedir(), ".codex", "bin", "playwright-cli"),
  ].filter(Boolean);

  for (const candidate of configuredCandidates) {
    if (await isExecutable(candidate)) {
      return candidate;
    }
  }

  for (const directory of (environment.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(directory, "playwright-cli");
    if (await isExecutable(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    "playwright-cli was not found. Set PLAYWRIGHT_CLI, CODEX_HOME, or add playwright-cli to PATH.",
  );
}

const PLAYWRIGHT_CLI = await resolvePlaywrightCli();

const WORKBENCH_STUB = String.raw`
  (() => {
    let config = {
      app: { launchAtLogin: false },
      vpn: {
        username: "keyboard-qa-user",
        password: "keyboard-qa-password",
        remoteDebugPort: 9222,
        maintainerIntervalSeconds: 300,
        maintainerAutoStart: false,
        maintainerQuietHoursEnabled: false,
        maintainerQuietStart: "18:30",
        maintainerQuietEnd: "09:00",
        appExecutable: "/Applications/EasyConnect.app/Contents/MacOS/EasyConnect",
        gateways: [{ host: "203.0.113.10", port: 9898 }],
      },
    };
    const status = {
      loginStatus: { status: "1" },
      activeSession: { sessionId: "keyboard-qa-session" },
      serviceState: { base: 18, l3vpn: 18, tcp: 43 },
      officialUi: {
        reachable: true,
        primaryKind: "service",
        hasServiceTarget: true,
        hasVisibleServiceTarget: true,
      },
    };
    const environmentInfo = {
      appExecutableExists: true,
      gatewayCandidates: [{ host: "203.0.113.10", port: 9898 }],
    };
    const maintainerStatus = {
      running: false,
      cycleCount: 0,
      lastEventAt: null,
      lastEvent: null,
      quietHours: { active: false, start: "18:30", end: "09:00" },
    };
    const clone = (value) => structuredClone(value);
    window.__rendererKeyboardQa = { saveCalls: 0 };
    window.workbench = Object.freeze({
      getConfig: async () => clone(config),
      saveConfig: async (nextConfig) => {
        config = clone(nextConfig);
        window.__rendererKeyboardQa.saveCalls += 1;
        return clone(config);
      },
      getVpnSnapshot: async () => ({ status: clone(status), environmentInfo: clone(environmentInfo) }),
      getVpnStatus: async () => clone(status),
      getEnvironmentInfo: async () => clone(environmentInfo),
      getRecoveryPlan: async () => ({ gateways: [], fallback: "portal-debug" }),
      probeRecoveryPlan: async () => [],
      launchOfficialClient: async () => ({
        action: "stub-launch",
        details: { visible: "activity-detail-value", token: "activity-detail-secret" },
      }),
      recoverOfficialClient: async () => ({ action: "stub-recover" }),
      getDebugTargets: async () => [],
      portalLogin: async () => ({ action: "stub-portal-login" }),
      recoverAndLogin: async () => ({ action: "stub-recover-login", status: clone(status) }),
      repairOfficialUi: async () => ({ action: "already-consistent" }),
      getMaintainerStatus: async () => clone(maintainerStatus),
      startMaintainer: async () => ({ running: true, quietHours: { active: false } }),
      stopMaintainer: async () => ({ running: false }),
      openLogsDir: async () => true,
      openConfigDir: async () => true,
    });
  })();
`;

const BROWSER_ASSERTIONS = String.raw`
async (page) => {
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  await page.waitForFunction(() => document.querySelector("#connection-title")?.textContent === "连接受到保护");

  for (const viewport of [
    { width: 1536, height: 1152, expectContentScroll: false },
    {
      width: 1152,
      height: 864,
      expectContentScroll: false,
      screenshotPath: ${JSON.stringify(join(SCREENSHOT_DIR, "vpn-only-1152x864.png"))},
    },
    { width: 900, height: 720, expectContentScroll: false },
    {
      width: 900,
      height: 640,
      expectContentScroll: true,
      screenshotPath: ${JSON.stringify(join(SCREENSHOT_DIR, "vpn-only-900x640.png"))},
    },
    {
      width: 720,
      height: 760,
      expectContentScroll: true,
      screenshotPath: ${JSON.stringify(join(SCREENSHOT_DIR, "vpn-only-720x760.png"))},
    },
  ]) {
    await page.setViewportSize(viewport);
    const layout = await page.evaluate(() => {
      const section = document.querySelector('[aria-labelledby="maintainer-heading"]');
      const content = document.querySelector(".app-content");
      const heading = section.querySelector(".section-heading > div").getBoundingClientRect();
      const action = document.querySelector("#maintainer-action").getBoundingClientRect();
      const sectionRect = section.getBoundingClientRect();
      const valuesFit = Array.from(section.querySelectorAll("dd")).every((node) => {
        const rect = node.getBoundingClientRect();
        return rect.left >= sectionRect.left - 1 && rect.right <= sectionRect.right + 1;
      });
      const actionOverlapsHeading = !(
        action.right <= heading.left ||
        action.left >= heading.right ||
        action.bottom <= heading.top ||
        action.top >= heading.bottom
      );
      return {
        noHorizontalOverflow: document.documentElement.scrollWidth <= window.innerWidth,
        documentFitsViewport:
          document.documentElement.scrollHeight <= window.innerHeight && document.body.scrollHeight <= window.innerHeight,
        contentScrolls: content.scrollHeight > content.clientHeight + 1,
        contentScrollHeight: content.scrollHeight,
        contentClientHeight: content.clientHeight,
        contentOverflowY: getComputedStyle(content).overflowY,
        regionHeights: Object.fromEntries(
          [".connection-band", ".summary-strip", ".overview-grid", ".activity-preview"].map((selector) => [
            selector,
            Math.round(document.querySelector(selector).getBoundingClientRect().height),
          ]),
        ),
        valuesFit,
        actionOverlapsHeading,
      };
    });
    assert(layout.noHorizontalOverflow, viewport.width + "px viewport must not overflow horizontally");
    assert(layout.documentFitsViewport, viewport.width + "px page shell must stay inside the viewport");
    assert(layout.contentOverflowY === "auto", viewport.width + "px main content must own vertical overflow");
    if (viewport.expectContentScroll !== undefined) {
      assert(
        layout.contentScrolls === viewport.expectContentScroll,
        viewport.width + "x" + viewport.height + " content scroll expectation must match (" +
          layout.contentScrollHeight + "px content / " + layout.contentClientHeight + "px viewport; " +
          JSON.stringify(layout.regionHeights) + ")",
      );
    }
    assert(layout.valuesFit, viewport.width + "px maintainer values must stay inside their section");
    assert(!layout.actionOverlapsHeading, viewport.width + "px maintainer heading and action must not overlap");
    if (viewport.screenshotPath) {
      await page.screenshot({ path: viewport.screenshotPath });
    }
  }

  const openButton = page.locator("#open-settings");
  await openButton.focus();
  await openButton.click();
  await page.waitForFunction(() => document.activeElement?.id === "vpn-username");

  const opened = await page.evaluate(() => ({
    drawerInert: document.querySelector("#settings-drawer").hasAttribute("inert"),
    shellInert: document.querySelector(".app-shell").hasAttribute("inert"),
    focusInside: document.querySelector("#settings-drawer").contains(document.activeElement),
  }));
  assert(!opened.drawerInert, "opening settings must remove drawer inertness");
  assert(opened.shellInert, "opening settings must make the app shell inert");
  assert(opened.focusInside, "opening settings must move focus into the dialog");

  await page.locator("#save-config").focus();
  await page.keyboard.press("Tab");
  assert(await page.evaluate(() => document.activeElement?.id === "close-settings"), "Tab must wrap last to first");

  await page.locator("#close-settings").focus();
  await page.keyboard.press("Shift+Tab");
  assert(await page.evaluate(() => document.activeElement?.id === "save-config"), "Shift+Tab must wrap first to last");

  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.activeElement?.id === "open-settings");
  const closed = await page.evaluate(() => ({
    drawerInert: document.querySelector("#settings-drawer").hasAttribute("inert"),
    shellInert: document.querySelector(".app-shell").hasAttribute("inert"),
    drawerOpen: document.querySelector("#settings-drawer").classList.contains("is-open"),
  }));
  assert(closed.drawerInert, "Escape must restore drawer inertness");
  assert(!closed.shellInert, "Escape must clear app-shell inertness");
  assert(!closed.drawerOpen, "Escape must close the drawer");

  await openButton.click();
  await page.waitForFunction(() => document.activeElement?.id === "vpn-username");
  await page.locator("#vpn-username").fill("keyboard-qa-saved-user");
  await page.locator("#vpn-username").focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => (
    window.__rendererKeyboardQa.saveCalls === 1 &&
    document.querySelector("#settings-feedback-title")?.textContent === "设置已保存"
  ));
  const saved = await page.evaluate(() => {
    const feedback = document.querySelector("#settings-feedback");
    return {
      inline: document.querySelector("#settings-drawer").contains(feedback),
      hidden: feedback.classList.contains("is-hidden"),
      title: document.querySelector("#settings-feedback-title").textContent,
    };
  });
  assert(saved.inline, "saved feedback must remain inside the settings drawer");
  assert(!saved.hidden, "saved feedback must be visible");
  assert(saved.title === "设置已保存", "Enter must submit through the real form handler");

  await page.keyboard.press("Escape");
  await page.locator("#show-activity").click();
  await page.locator(".diagnostics > summary").click();
  await page.locator("#launch-client").click();
  await page.waitForFunction(() => document.querySelector("#activity-list details summary")?.textContent === "查看详情");
  const activity = await page.evaluate(() => ({
    recentCount: document.querySelectorAll("#recent-activity-list .activity-item").length,
    fullDetails: Array.from(document.querySelectorAll("#activity-list details")).map((node) => node.textContent),
    overviewDetails: document.querySelector("#recent-activity-list details") !== null,
  }));
  assert(activity.recentCount === 3, "overview must show exactly three recent activity entries");
  assert(activity.fullDetails.some((text) => text.includes("activity-detail-value")), "full activity must show sanitized details");
  assert(activity.fullDetails.every((text) => !text.includes("activity-detail-secret")), "activity details must redact sensitive values");
  assert(!activity.overviewDetails, "overview activity preview must stay compact");
}
`;

const MIME_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
]);

function runPlaywright(args, { allowFailure = false } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(PLAYWRIGHT_CLI, ["--json", "--session", SESSION_NAME, ...args], {
      cwd: tmpdir(),
      env: {
        ...process.env,
        PATH: `${NODE_BIN_DIR}:${process.env.PATH ?? ""}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      let response = null;
      try {
        response = JSON.parse(stdout);
      } catch {
        // Preserve the command output below when the CLI cannot return JSON.
      }
      const failed = code !== 0 || response?.isError === true;
      if (!failed || allowFailure) {
        resolvePromise({ code, stdout, stderr });
        return;
      }
      rejectPromise(
        new Error(
          response?.error ?? `playwright-cli ${args[0]} failed with exit ${code}\n${stdout}${stderr}`.trim(),
        ),
      );
    });
  });
}

function createRendererServer() {
  const rootPath = resolve(ROOT_DIR);
  return createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      const pathname = decodeURIComponent(requestUrl.pathname);
      const normalizedPath = pathname === "/" ? "/src/renderer/index.html" : pathname;
      const filePath = resolve(rootPath, `.${normalizedPath}`);
      if (filePath !== rootPath && !filePath.startsWith(`${rootPath}${sep}`)) {
        response.writeHead(403).end("Forbidden");
        return;
      }

      let content = await readFile(filePath);
      if (normalizedPath === "/src/renderer/index.html") {
        content = Buffer.from(
          content.toString("utf8").replace("</head>", `<script>${WORKBENCH_STUB}</script></head>`),
        );
      }
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-type": MIME_TYPES.get(extname(filePath)) ?? "application/octet-stream",
      });
      response.end(content);
    } catch (error) {
      const status = error?.code === "ENOENT" ? 404 : 500;
      response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
      response.end(status === 404 ? "Not found" : "Internal server error");
    }
  });
}

function listen(server) {
  return new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectPromise);
      resolvePromise();
    });
  });
}

function closeServer(server) {
  return new Promise((resolvePromise, rejectPromise) => {
    if (!server.listening) {
      resolvePromise();
      return;
    }
    server.close((error) => {
      if (error) {
        rejectPromise(error);
        return;
      }
      resolvePromise();
    });
  });
}

const server = createRendererServer();

try {
  await mkdir(SCREENSHOT_DIR, { recursive: true });
  await listen(server);
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/src/renderer/index.html`;
  await runPlaywright(["close"], { allowFailure: true });
  await runPlaywright(["open", url]);
  await runPlaywright(["run-code", BROWSER_ASSERTIONS]);
  console.log("renderer keyboard and viewport QA passed: 5 viewports");
} catch (error) {
  console.error(error?.stack ?? String(error));
  process.exitCode = 1;
} finally {
  try {
    await runPlaywright(["close"], { allowFailure: true });
  } finally {
    await closeServer(server);
  }
}
