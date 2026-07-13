import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT_DIR = fileURLToPath(new URL("../", import.meta.url));
const PLAYWRIGHT_CLI = "/Users/jasonj/.codex/bin/playwright-cli";
const SESSION_NAME = "easyconnect-vpn-only-keyboard-qa";
const NODE_BIN_DIR = "/Users/jasonj/.nvm/versions/node/v24.14.0/bin";

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
      launchOfficialClient: async () => ({ action: "stub-launch" }),
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
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  await page.waitForFunction(() => document.querySelector("#connection-title")?.textContent === "连接受到保护");

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
    const child = spawn(PLAYWRIGHT_CLI, ["--session", SESSION_NAME, ...args], {
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
      if (code === 0 || allowFailure) {
        resolvePromise({ code, stdout, stderr });
        return;
      }
      rejectPromise(
        new Error(
          `playwright-cli ${args[0]} failed with exit ${code}\n${stdout}${stderr}`.trim(),
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
  await listen(server);
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/src/renderer/index.html`;
  await runPlaywright(["close"], { allowFailure: true });
  await runPlaywright(["open", url]);
  await runPlaywright(["run-code", BROWSER_ASSERTIONS]);
  console.log("renderer keyboard QA passed: 5 behaviors");
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
