import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import {
  EasyConnectRuntime,
  buildAgentProxyResetFinalState,
  buildContainerConfigWriteExpression,
  buildContainerRuntimeBatchWriteExpression,
  buildContainerRuntimeWriteExpression,
  buildLaunchctlActionEntry,
  buildPortalOfficialServiceStartExpression,
  buildPortalGlobalWriteSpecs,
  buildPortalInitConfigData,
  buildPortalOfficialPasswordLoginExpression,
  buildPortalReloadExpression,
  extractTokensFromCacheFromDir,
  filterProcessesByExecutable,
  parseLaunchctlPrintState,
} from "../src/easyconnect-bridge/runtime.mjs";
import { ensureOnline } from "../src/easyconnect-bridge/maintainer.mjs";

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function createOrphanSocket(filePath) {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `
        const net = require("node:net");
        const server = net.createServer();
        server.listen(process.env.SOCKET_PATH, () => process.stdout.write("ready\\n"));
        setInterval(() => {}, 1000);
      `,
    ],
    {
      env: { ...process.env, SOCKET_PATH: filePath },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  await new Promise((resolve, reject) => {
    let stderr = "";
    const onExit = (code) => reject(new Error(`socket child exited before ready: ${code}; ${stderr}`));
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.once("exit", onExit);
    child.stdout.on("data", (chunk) => {
      if (chunk.toString("utf8").includes("ready")) {
        child.off("exit", onExit);
        resolve();
      }
    });
  });

  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));
}

test("buildPortalInitConfigData derives the login init config required by official service pages", () => {
  assert.deepEqual(
    buildPortalInitConfigData({
      midAtkCheck: "1",
      nextService: "auth/psw",
    }),
    {
      enableSavePwd: 0,
      enableAutoLogin: 0,
      unforceInstallClient: 1,
      enableSecurityCheck: false,
      enableMidAtkCheck: 1,
      startAuth: "auth/psw",
      domainSSOEnable: false,
    },
  );
});

test("buildPortalOfficialPasswordLoginExpression uses official auth APIs instead of password vm automation", () => {
  const expression = buildPortalOfficialPasswordLoginExpression("demo-user", "secret", "");

  assert.match(expression, /SF\.auth\.getLoginConfig/);
  assert.match(expression, /SF\.auth\.authPsw/);
  assert.match(expression, /notCheck:\s*true/);
  assert.doesNotMatch(expression, /vm\.login/);
});

test("buildPortalOfficialServiceStartExpression uses official service APIs after renderer login", () => {
  const expression = buildPortalOfficialServiceStartExpression("demo-user");

  assert.match(expression, /SFAPI\.setTWFID/);
  assert.match(expression, /SFAPI\.startService/);
  assert.match(expression, /SF\.session\.createInstance/);
  assert.match(expression, /SF\.vpnInfo\.createInstance/);
  assert.match(expression, /saveLoginInfo/);
  assert.match(expression, /saveTempLoginInfo/);
  assert.match(expression, /syncLoginInfo/);
  assert.match(expression, /userName:\s*username/);
  assert.match(expression, /KEY_GLOBAL_LOGIN_NAME/);
  assert.match(expression, /KEY_GLOBAL_VPN_URL/);
  assert.match(expression, /KEY_GLOBAL_FROM_URL/);
  assert.match(expression, /KEY_VPN_BASE_INFO/);
  assert.match(expression, /setShm/);
  assert.match(expression, /syncSession/);
  assert.match(expression, /S_SERVADDR/);
  assert.match(expression, /S_LOGINADDR/);
  assert.match(expression, /onStateChanged/);
  assert.doesNotMatch(expression, /sslservice\.sh/);
});

test("buildPortalGlobalWriteSpecs does not leave initGetInitConfigData empty on service pages", () => {
  const result = buildPortalGlobalWriteSpecs(
    {
      sessionId: "session-1",
      gatewayHost: "203.0.113.10",
      gatewayPort: 9898,
      username: "demo-user",
      passwordConfigSummary: {
        midAtkCheck: "0",
        nextService: "auth/psw",
      },
    },
    { profile: "service" },
  );

  const initConfigWrite = result.runtimeWriteSpecs.find(
    ([keyPath]) => keyPath === "/global/initGetInitConfigData",
  );

  assert.deepEqual(initConfigWrite, [
    "/global/initGetInitConfigData",
    {
      enableSavePwd: 0,
      enableAutoLogin: 0,
      unforceInstallClient: 1,
      enableSecurityCheck: false,
      enableMidAtkCheck: 0,
      startAuth: "auth/psw",
      domainSSOEnable: false,
    },
    0,
  ]);
});

test("buildPortalGlobalWriteSpecs never emits undefined container write values", () => {
  const result = buildPortalGlobalWriteSpecs(
    {
      sessionId: "session-1",
      gatewayHost: "203.0.113.10",
      gatewayPort: 9898,
      username: undefined,
      browserType: undefined,
      lang: undefined,
      loginClientType: undefined,
      trayType: undefined,
      twfIDTmp: undefined,
      ecGuid: undefined,
      reloginStatus: undefined,
      isFromEC: undefined,
      hasTcpResource: undefined,
      hasRemoteApp: undefined,
      lastVPNURL: undefined,
      vpnURLList: undefined,
      initGetInitConfigData: undefined,
      passwordConfigSummary: {},
    },
    { profile: "service" },
  );

  assert.equal(
    result.runtimeWriteSpecs.some(([, value]) => value === undefined),
    false,
  );
});

test("container write expressions normalize undefined before calling EasyConnect APIs", () => {
  const configExpression = buildContainerConfigWriteExpression("token", undefined);
  const runtimeExpression = buildContainerRuntimeWriteExpression("/global/loginName", undefined);
  const batchExpression = buildContainerRuntimeBatchWriteExpression([
    { keyPath: "/global/loginName", value: undefined, persist: 0 },
  ]);

  assert.doesNotMatch(configExpression, /undefined/);
  assert.doesNotMatch(runtimeExpression, /undefined/);
  assert.doesNotMatch(batchExpression, /undefined/);
  assert.match(configExpression, /ecWriteConfig\("token", ""/);
  assert.equal(runtimeExpression.includes('ecSet("/global/loginName", "", 0)'), true);
  assert.match(batchExpression, /"value":""/);
});

test("buildPortalReloadExpression schedules a real page reload after returning", () => {
  const expression = buildPortalReloadExpression();

  assert.match(expression, /setTimeout\(\(\) => location\.reload\(\), 0\)/);
  assert.match(expression, /beforeHref/);
});

test("extractTokensFromCacheFromDir caps cache scanning in huge EasyConnect cache dirs", async () => {
  const entries = Array.from({ length: 3000 }, (_, index) => ({
    name: `entry-${index}`,
    isFile: () => true,
  }));
  let statCalls = 0;

  const fsOps = {
    async access() {},
    async opendir() {
      return {
        async *[Symbol.asyncIterator]() {
          for (const entry of entries) {
            yield entry;
          }
        },
        async close() {},
      };
    },
    async stat(filePath) {
      statCalls += 1;
      const index = Number.parseInt(filePath.match(/entry-(\d+)$/)?.[1] ?? "0", 10);
      return {
        mtimeMs: 10_000 - index,
      };
    },
    async readFile(filePath) {
      return Buffer.from(filePath.endsWith("entry-0") ? "token=0123456789abcdef0123456789abcdef" : "", "latin1");
    },
  };

  const tokens = await extractTokensFromCacheFromDir("/tmp/cache", 40, fsOps);

  assert.equal(statCalls, 2000);
  assert.deepEqual(tokens, ["0123456789abcdef0123456789abcdef"]);
});

test("filterProcessesByExecutable does not match executable name prefixes", () => {
  const resourcesDir = "/Applications/EasyConnect.app/Contents/Resources";
  const processes = [
    {
      pid: 101,
      ppid: 1,
      command: `${resourcesDir}/bin/ECAgent --resume`,
    },
    {
      pid: 102,
      ppid: 1,
      command: `${resourcesDir}/bin/ECAgentProxy`,
    },
    {
      pid: 103,
      ppid: 1,
      command: `${resourcesDir}/bin/EasyMonitor`,
    },
  ];

  assert.deepEqual(
    filterProcessesByExecutable(processes, `${resourcesDir}/bin/ECAgent`).map((process) => process.pid),
    [101],
  );
  assert.deepEqual(
    filterProcessesByExecutable(processes, `${resourcesDir}/bin/ECAgentProxy`).map((process) => process.pid),
    [102],
  );
});

test("agent proxy reset final state treats kickstart failure as non-fatal when launchd reports running", () => {
  const launchctlOutput = `
gui/501/com.sangfor.ECAgentProxy = {
  inherited environment = {
    TENCENT_DOCS_TOKEN => should-not-leak
  }
  state = running
  runs = 2
  pid = 74681
}
`;
  const launchService = parseLaunchctlPrintState(launchctlOutput);
  const printAction = buildLaunchctlActionEntry({
    action: "print",
    ok: true,
    stdout: launchctlOutput,
    outputMode: "launchctl-print",
  });
  const result = buildAgentProxyResetFinalState({
    actions: [
      { action: "bootout", ok: false, stderr: "Boot-out failed: 5: Input/output error" },
      { action: "pkill-term", ok: true },
      { action: "pkill-kill", ok: true },
      { action: "bootstrap", ok: true },
      { action: "kickstart", ok: false, stderr: "" },
    ],
    launchService,
    processes: {
      ecAgentProxy: [],
    },
  });

  assert.deepEqual(printAction, {
    action: "print",
    ok: true,
    launchService: {
      state: "running",
      running: true,
      pid: 74681,
      runs: 2,
    },
  });
  assert.equal(JSON.stringify(printAction).includes("should-not-leak"), false);

  assert.deepEqual(result, {
    ok: true,
    running: true,
    source: "launchctl",
    state: "running",
    pid: 74681,
    nonFatalActionFailures: ["bootout", "kickstart"],
    fatalActionFailures: [],
  });
});

test("recoverViaUserMode reuses an existing responsive EasyConnect debug target instead of relaunching", async () => {
  const calls = [];
  const existingTarget = {
    remoteDebugPort: 9222,
    targetCount: 1,
    target: {
      id: "target-1",
      type: "page",
      url: "https://198.51.100.20:9898/portal/#!/login",
      webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/target-1",
    },
  };

  class TestRuntime extends EasyConnectRuntime {
    async findReusableRemoteDebugPageTarget(options) {
      calls.push(["findReusableRemoteDebugPageTarget", options.remoteDebugPort]);
      return existingTarget;
    }

    async collectRecoveryDiagnostics() {
      calls.push("collectRecoveryDiagnostics");
      return { classification: "unknown" };
    }

    async disableOfficialAutoConnectBeforeLaunch(options) {
      calls.push(["disableOfficialAutoConnectBeforeLaunch", options.remoteDebugPort]);
      return { ok: true, action: "already-enabled" };
    }

    async killMainAppProcesses() {
      calls.push("killMainAppProcesses");
      return {};
    }

    async launchMainAppUserMode() {
      calls.push("launchMainAppUserMode");
      return {};
    }
  }

  const result = await new TestRuntime().recoverViaUserMode({ remoteDebugPort: 9222 });

  assert.deepEqual(calls, [
    "collectRecoveryDiagnostics",
    ["findReusableRemoteDebugPageTarget", 9222],
    ["disableOfficialAutoConnectBeforeLaunch", 9222],
  ]);
  assert.equal(result.mode, "reuse-existing-main-app");
  assert.deepEqual(result.reusedExistingMainApp, existingTarget);
  assert.equal(result.launched, null);
  assert.equal(result.killed.action, "skipped-existing-debug-target");
});

test("findReusableRemoteDebugPageTarget rejects loading and connect failure targets", async () => {
  const calls = [];

  class TestRuntime extends EasyConnectRuntime {
    async getRemoteDebugTargets() {
      return [
        {
          id: "loading-login",
          type: "page",
          title: "Loading...",
          url: "https://198.51.100.20:9898/portal/#!/login",
          webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/loading-login",
        },
        {
          id: "connect-notfound",
          type: "page",
          title: "EasyConnect",
          url: "file:///Applications/EasyConnect.app/Contents/Resources/Web/local/connect_notfound/connect_notfound.html?from=https%3A%2F%2F198.51.100.20%3A9898%2Fportal%2F%23!%2Fservice",
          webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/connect-notfound",
        },
        {
          id: "connect-page",
          type: "page",
          title: "EasyConnect",
          url: "file:///Applications/EasyConnect.app/Contents/Resources/Web/local/connect/connect.html",
          webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/connect-page",
        },
      ];
    }

    async ensureRemoteDebugPageTargetResponsive(target) {
      calls.push(["ensureRemoteDebugPageTargetResponsive", target.id]);
      return true;
    }
  }

  const result = await new TestRuntime().findReusableRemoteDebugPageTarget({ remoteDebugPort: 9222 });

  assert.equal(result, null);
  assert.deepEqual(calls, []);
});

test("recoverViaUserMode relaunches when existing remote targets are only broken pages", async () => {
  const calls = [];

  class TestRuntime extends EasyConnectRuntime {
    async getRemoteDebugTargets() {
      calls.push("getRemoteDebugTargets");
      return [
        {
          id: "notfound",
          type: "page",
          title: "EasyConnect",
          url: "file:///Applications/EasyConnect.app/Contents/Resources/Web/local/connect_notfound/connect_notfound.html",
          webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/notfound",
        },
      ];
    }

    async collectRecoveryDiagnostics() {
      calls.push("collectRecoveryDiagnostics");
      return { classification: "unknown" };
    }

    async listMainAppProcesses() {
      calls.push("listMainAppProcesses");
      return [{ pid: 9001, ppid: 1, command: this.appExecutable }];
    }

    async killMainAppProcesses() {
      calls.push("killMainAppProcesses");
      return { forced: true };
    }

    async waitForMainAppProcessesStopped() {
      calls.push("waitForMainAppProcessesStopped");
      return { ok: true, processes: [] };
    }

    async killCoreServiceProcesses() {
      calls.push("killCoreServiceProcesses");
      return { forced: true };
    }

    async resetAgentProxy() {
      calls.push("resetAgentProxy");
      return { finalState: { ok: true, running: true } };
    }

    async waitForAgentProxyReady() {
      calls.push("waitForAgentProxyReady");
      return { ok: true, running: true };
    }

    async disableOfficialAutoConnectBeforeLaunch() {
      calls.push("disableOfficialAutoConnectBeforeLaunch");
      return { ok: true, action: "already-enabled" };
    }

    async launchMainAppUserMode() {
      calls.push("launchMainAppUserMode");
      return { action: "launched", pid: 1234 };
    }
  }

  const result = await new TestRuntime().recoverViaUserMode({ remoteDebugPort: 9222 });

  assert.equal(result.mode, "relaunch-main-app");
  assert.equal(result.launched.pid, 1234);
  assert.deepEqual(calls, [
    "collectRecoveryDiagnostics",
    "getRemoteDebugTargets",
    "listMainAppProcesses",
    "killMainAppProcesses",
    "waitForMainAppProcessesStopped",
    "killCoreServiceProcesses",
    "resetAgentProxy",
    "waitForAgentProxyReady",
    "disableOfficialAutoConnectBeforeLaunch",
    "launchMainAppUserMode",
  ]);
});

test("recoverViaUserMode relaunches when recent official logs show a native crash even if a target responds", async () => {
  const calls = [];
  const existingTarget = {
    remoteDebugPort: 9222,
    targetCount: 1,
    target: {
      id: "login-target",
      type: "page",
      title: "EasyConnect",
      url: "https://198.51.100.20:9898/portal/#!/login",
      webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/login-target",
    },
  };

  class TestRuntime extends EasyConnectRuntime {
    async collectRecoveryDiagnostics() {
      calls.push("collectRecoveryDiagnostics");
      return {
        classification: "official-ui-crashed",
        officialLogs: {
          easyconnect: [
            "crash_service run exception, reason:uncaughtException descrition: AssertionError [ERR_ASSERTION]",
            "Assert(typeof value!=\"undefined\")",
          ],
        },
      };
    }

    async findReusableRemoteDebugPageTarget() {
      calls.push("findReusableRemoteDebugPageTarget");
      return existingTarget;
    }

    async listMainAppProcesses() {
      calls.push("listMainAppProcesses");
      return [{ pid: 9001, ppid: 1, command: this.appExecutable }];
    }

    async killMainAppProcesses() {
      calls.push("killMainAppProcesses");
      return { forced: true };
    }

    async waitForMainAppProcessesStopped() {
      calls.push("waitForMainAppProcessesStopped");
      return { ok: true, processes: [] };
    }

    async killCoreServiceProcesses() {
      calls.push("killCoreServiceProcesses");
      return { forced: true };
    }

    async resetAgentProxy() {
      calls.push("resetAgentProxy");
      return { finalState: { ok: true, running: true } };
    }

    async waitForAgentProxyReady() {
      calls.push("waitForAgentProxyReady");
      return { ok: true, running: true };
    }

    async disableOfficialAutoConnectBeforeLaunch() {
      calls.push("disableOfficialAutoConnectBeforeLaunch");
      return { ok: true, action: "already-enabled" };
    }

    async launchMainAppUserMode() {
      calls.push("launchMainAppUserMode");
      return { action: "launched", pid: 1234 };
    }
  }

  const result = await new TestRuntime().recoverViaUserMode({ remoteDebugPort: 9222 });

  assert.equal(result.mode, "relaunch-main-app");
  assert.equal(result.reuseBypassed.classification, "official-ui-crashed");
  assert.deepEqual(calls, [
    "collectRecoveryDiagnostics",
    "listMainAppProcesses",
    "killMainAppProcesses",
    "waitForMainAppProcessesStopped",
    "killCoreServiceProcesses",
    "resetAgentProxy",
    "waitForAgentProxyReady",
    "disableOfficialAutoConnectBeforeLaunch",
    "launchMainAppUserMode",
  ]);
});

test("recoverViaUserMode clears stale core services before relaunching EasyConnect", async () => {
  const calls = [];

  class TestRuntime extends EasyConnectRuntime {
    async collectRecoveryDiagnostics() {
      calls.push("collectRecoveryDiagnostics");
      return { classification: "unknown" };
    }

    async findReusableRemoteDebugPageTarget(options) {
      calls.push(["findReusableRemoteDebugPageTarget", options.remoteDebugPort]);
      return null;
    }

    async listMainAppProcesses() {
      calls.push("listMainAppProcesses");
      return [
        {
          pid: 9001,
          ppid: 1,
          command: this.appExecutable,
        },
      ];
    }

    async killMainAppProcesses(options) {
      calls.push(["killMainAppProcesses", options.force]);
      return { command: "EasyConnect", forced: options.force };
    }

    async waitForMainAppProcessesStopped(options) {
      calls.push(["waitForMainAppProcessesStopped", options.timeoutMs]);
      return { ok: true, processes: [] };
    }

    async killCoreServiceProcesses(options) {
      calls.push(["killCoreServiceProcesses", options.force]);
      return { commands: ["CSClient", "svpnservice"], forced: options.force };
    }

    async resetAgentProxy(options) {
      calls.push(["resetAgentProxy", options.force]);
      return {
        label: "com.sangfor.ECAgentProxy",
        forced: options.force,
        finalState: { ok: true, running: true },
      };
    }

    async waitForAgentProxyReady(options) {
      calls.push(["waitForAgentProxyReady", options.timeoutMs]);
      return { ok: true, running: true, source: "launchctl" };
    }

    async disableOfficialAutoConnectBeforeLaunch() {
      calls.push("disableOfficialAutoConnectBeforeLaunch");
      return { ok: true, action: "enabled", key: "global.notAutoConnect", value: null };
    }

    async launchMainAppUserMode(options) {
      calls.push(["launchMainAppUserMode", options.remoteDebugPort]);
      return { pid: 1234, remoteDebugPort: options.remoteDebugPort };
    }
  }

  const runtime = new TestRuntime();
  const result = await runtime.recoverViaUserMode({
    remoteDebugPort: 9222,
    forceKill: true,
  });

  assert.deepEqual(calls, [
    "collectRecoveryDiagnostics",
    ["findReusableRemoteDebugPageTarget", 9222],
    "listMainAppProcesses",
    ["killMainAppProcesses", true],
    ["waitForMainAppProcessesStopped", 10000],
    ["killCoreServiceProcesses", true],
    ["resetAgentProxy", true],
    ["waitForAgentProxyReady", 15000],
    "disableOfficialAutoConnectBeforeLaunch",
    ["launchMainAppUserMode", 9222],
  ]);
  assert.deepEqual(result.killedCoreServices, {
    commands: ["CSClient", "svpnservice"],
    forced: true,
  });
  assert.deepEqual(result.existingMainAppProcesses, [
    {
      pid: 9001,
      ppid: 1,
      command: runtime.appExecutable,
    },
  ]);
  assert.deepEqual(result.mainAppStopped, { ok: true, processes: [] });
  assert.deepEqual(result.resetAgentProxy, {
    label: "com.sangfor.ECAgentProxy",
    forced: true,
    finalState: { ok: true, running: true },
  });
  assert.deepEqual(result.agentProxyReady, { ok: true, running: true, source: "launchctl" });
  assert.deepEqual(result.disabledOfficialAutoConnect, {
    ok: true,
    action: "enabled",
    key: "global.notAutoConnect",
    value: null,
  });
});

test("launchMainAppFromEcAgent preserves remote debugging when relaunching the official UI", async () => {
  const calls = [];

  class TestRuntime extends EasyConnectRuntime {
    async getPort() {
      calls.push("getPort");
      return 54530;
    }

    async killMainAppProcesses() {
      calls.push("killMainAppProcesses");
      return {};
    }

    async waitForMainAppProcessesStopped() {
      calls.push("waitForMainAppProcessesStopped");
      return { ok: true, processes: [] };
    }

    spawnMainApp(args) {
      calls.push(["spawnMainApp", args]);
      return 7001;
    }
  }

  const runtime = new TestRuntime();
  const result = await runtime.launchMainAppFromEcAgent("session-1", {
    remoteDebugPort: 9222,
  });

  assert.deepEqual(calls, [
    "getPort",
    "killMainAppProcesses",
    "waitForMainAppProcessesStopped",
    [
      "spawnMainApp",
      [
        "--remote-debugging-port=9222",
        "--from",
        "ecagent",
        "--agentport",
        "54530",
        "--token",
        EasyConnectRuntime.deriveToken("session-1"),
        "--twfid",
        EasyConnectRuntime.encodeLaunchTwfId("session-1"),
      ],
    ],
  ]);
  assert.equal(result.pid, 7001);
  assert.equal(result.remoteDebugPort, 9222);
  assert.equal(result.token, EasyConnectRuntime.deriveToken("session-1"));
});

test("launchMainAppUserMode restarts an existing non-debuggable official app instead of stacking a second instance", async () => {
  const calls = [];

  class TestRuntime extends EasyConnectRuntime {
    async findReusableRemoteDebugPageTarget(options) {
      calls.push(["findReusableRemoteDebugPageTarget", options.remoteDebugPort]);
      return null;
    }

    async listMainAppProcesses() {
      calls.push("listMainAppProcesses");
      return [
        {
          pid: 9002,
          ppid: 1,
          command: this.appExecutable,
        },
      ];
    }

    async killMainAppProcesses(options) {
      calls.push(["killMainAppProcesses", options.force]);
      return { command: this.appExecutable, forced: options.force };
    }

    async waitForMainAppProcessesStopped(options) {
      calls.push(["waitForMainAppProcessesStopped", options.timeoutMs]);
      return { ok: true, processes: [] };
    }

    spawnMainApp(args) {
      calls.push(["spawnMainApp", args]);
      return 9003;
    }
  }

  const runtime = new TestRuntime();
  const result = await runtime.launchMainAppUserMode({ remoteDebugPort: 9222 });

  assert.deepEqual(calls, [
    ["findReusableRemoteDebugPageTarget", 9222],
    "listMainAppProcesses",
    ["killMainAppProcesses", true],
    ["waitForMainAppProcessesStopped", 10000],
    ["spawnMainApp", ["--remote-debugging-port=9222"]],
  ]);
  assert.equal(result.action, "restarted-existing-without-debug");
  assert.equal(result.pid, 9003);
  assert.deepEqual(result.existingProcesses, [
    {
      pid: 9002,
      ppid: 1,
      command: runtime.appExecutable,
    },
  ]);
  assert.deepEqual(result.killed, { command: runtime.appExecutable, forced: true });
  assert.deepEqual(result.mainAppStopped, { ok: true, processes: [] });
});

test("recoverViaUserMode does not relaunch EasyConnect before ECAgentProxy is ready", async () => {
  const calls = [];

  class TestRuntime extends EasyConnectRuntime {
    async collectRecoveryDiagnostics() {
      calls.push("collectRecoveryDiagnostics");
      return { classification: "unknown" };
    }

    async findReusableRemoteDebugPageTarget() {
      calls.push("findReusableRemoteDebugPageTarget");
      return null;
    }

    async listMainAppProcesses() {
      calls.push("listMainAppProcesses");
      return [];
    }

    async killMainAppProcesses() {
      calls.push("killMainAppProcesses");
      return {};
    }

    async waitForMainAppProcessesStopped() {
      calls.push("waitForMainAppProcessesStopped");
      return { ok: true, processes: [] };
    }

    async killCoreServiceProcesses() {
      calls.push("killCoreServiceProcesses");
      return {};
    }

    async resetAgentProxy() {
      calls.push("resetAgentProxy");
      return { finalState: { ok: false, running: false, state: "spawn scheduled" } };
    }

    async waitForAgentProxyReady() {
      calls.push("waitForAgentProxyReady");
      const error = new Error("ECAgentProxy did not become ready");
      error.code = "EASYCONNECT_AGENT_PROXY_NOT_READY";
      throw error;
    }

    async disableOfficialAutoConnectBeforeLaunch() {
      calls.push("disableOfficialAutoConnectBeforeLaunch");
      return {};
    }

    async launchMainAppUserMode() {
      calls.push("launchMainAppUserMode");
      return {};
    }
  }

  await assert.rejects(
    () => new TestRuntime().recoverViaUserMode({ remoteDebugPort: 9222 }),
    (error) => error.code === "EASYCONNECT_AGENT_PROXY_NOT_READY",
  );
  assert.deepEqual(calls, [
    "collectRecoveryDiagnostics",
    "findReusableRemoteDebugPageTarget",
    "listMainAppProcesses",
    "killMainAppProcesses",
    "waitForMainAppProcessesStopped",
    "killCoreServiceProcesses",
    "resetAgentProxy",
    "waitForAgentProxyReady",
  ]);
});

test("disableOfficialAutoConnectBeforeLaunch clears persisted notAutoConnect before official app launch", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "easyconnect-setting-"));
  const appExecutable = path.join(tmpDir, "EasyConnect.app", "Contents", "MacOS", "EasyConnect");
  const confDir = path.join(tmpDir, "EasyConnect.app", "Contents", "Resources", "conf");
  const settingPath = path.join(confDir, `setting_${os.userInfo().username}.json`);
  await fs.mkdir(path.dirname(appExecutable), { recursive: true });
  await fs.mkdir(confDir, { recursive: true });
  await fs.writeFile(settingPath, JSON.stringify({
    global: {
      ecPort: "54530",
      notAutoConnect: 0,
    },
  }));

  class TestRuntime extends EasyConnectRuntime {
    async getRemoteDebugTargets() {
      return [];
    }
  }

  const runtime = new TestRuntime({ appExecutable });
  const result = await runtime.disableOfficialAutoConnectBeforeLaunch();
  const updated = JSON.parse(await fs.readFile(settingPath, "utf8"));

  assert.equal(result.ok, true);
  assert.equal(result.action, "enabled");
  assert.equal(result.fileWrite.ok, true);
  assert.equal(result.liveWrite.action, "no-page-targets");
  assert.equal(result.previousValue, 0);
  assert.equal(Object.hasOwn(updated.global, "notAutoConnect"), false);
});

test("disableOfficialAutoConnectBeforeLaunch avoids writing running container state", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "easyconnect-setting-"));
  const appExecutable = path.join(tmpDir, "EasyConnect.app", "Contents", "MacOS", "EasyConnect");
  const confDir = path.join(tmpDir, "EasyConnect.app", "Contents", "Resources", "conf");
  const settingPath = path.join(confDir, `setting_${os.userInfo().username}.json`);
  const calls = [];
  await fs.mkdir(path.dirname(appExecutable), { recursive: true });
  await fs.mkdir(confDir, { recursive: true });
  await fs.writeFile(settingPath, JSON.stringify({ global: {} }));

  class TestRuntime extends EasyConnectRuntime {
    async getRemoteDebugTargets(remoteDebugPort, options) {
      calls.push(["getRemoteDebugTargets", remoteDebugPort, options.timeoutMs]);
      return [
        {
          id: "connect-target",
          type: "page",
          title: "EasyConnect",
          url: "file:///Applications/EasyConnect.app/Contents/Resources/Web/local/connect/connect.html",
          webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/connect-target",
        },
      ];
    }

    async writeContainerRuntimeValueOnPageTarget(target, keyPath, value, options) {
      calls.push(["writeContainerRuntimeValueOnPageTarget", target.id, keyPath, value, options.persist]);
      return { ok: true };
    }
  }

  const runtime = new TestRuntime({ appExecutable });
  const result = await runtime.disableOfficialAutoConnectBeforeLaunch({
    remoteDebugPort: 9333,
    remoteDebugTimeoutMs: 77,
  });

  assert.equal(result.ok, true);
  assert.equal(result.fileWrite.ok, true);
  assert.equal(result.liveWrite.ok, false);
  assert.equal(result.liveWrite.action, "skipped-running-container-write");
  assert.deepEqual(calls, [
    ["getRemoteDebugTargets", 9333, 77],
  ]);
});

test("startCoreServices verifies official core processes after shell scripts return", async () => {
  class TestRuntime extends EasyConnectRuntime {
    async clearStaleLocalServiceSockets() {
      return { entries: [] };
    }

    async runOfficialShellScript(scriptName) {
      return { script: scriptName, stdout: "", stderr: "" };
    }

    async listCoreServiceProcesses() {
      return { csclient: [], svpnservice: [] };
    }
  }

  const runtime = new TestRuntime();

  await assert.rejects(
    () =>
      runtime.startCoreServices({
        username: "demo-user",
        gatewayHost: "198.51.100.20",
        gatewayPort: 9898,
        processCheckTimeoutMs: 10,
        processCheckPollMs: 1,
      }),
    /Core services did not become ready/,
  );
});

test("startCoreServices clears stale local service sockets before official scripts", async () => {
  const calls = [];

  class TestRuntime extends EasyConnectRuntime {
    async clearStaleLocalServiceSockets(options) {
      calls.push(["clearStaleLocalServiceSockets", options.signal ?? null]);
      return {
        entries: [
          { name: "ECDomainFile", action: "deleted" },
          { name: "ECRSESSIONSOCKFILE", action: "deleted" },
        ],
      };
    }

    async runOfficialShellScript(scriptName, args) {
      calls.push(["runOfficialShellScript", scriptName, args]);
      return { script: scriptName, stdout: "", stderr: "" };
    }

    async waitForCoreServiceProcesses() {
      calls.push(["waitForCoreServiceProcesses"]);
      return {
        csclient: [{ pid: 1001, command: "CSClient" }],
        svpnservice: [{ pid: 1002, command: "svpnservice" }],
      };
    }
  }

  const runtime = new TestRuntime();
  const result = await runtime.startCoreServices({
    username: "demo-user",
    gatewayHost: "198.51.100.20",
    gatewayPort: 9898,
  });

  assert.deepEqual(calls, [
    ["clearStaleLocalServiceSockets", null],
    ["runOfficialShellScript", "svpnservice.sh", ["-u", "demo-user"]],
    ["runOfficialShellScript", "sslservice.sh", ["-u", "demo-user", "-h", "198.51.100.20", "-p", "9898", "-s"]],
    ["waitForCoreServiceProcesses"],
  ]);
  assert.deepEqual(result.staleLocalServiceSockets.entries, [
    { name: "ECDomainFile", action: "deleted" },
    { name: "ECRSESSIONSOCKFILE", action: "deleted" },
  ]);
});

test("clearStaleLocalServiceSockets deletes only unheld EasyConnect sockets", async () => {
  const tempDir = await fs.mkdtemp("/tmp/ec-");
  const appExecutable = path.join(tempDir, "EC.app", "Contents", "MacOS", "EC");
  const confDir = path.join(tempDir, "EC.app", "Contents", "Resources", "conf");
  const orphanSocketPath = path.join(confDir, "ECDomainFile");
  const heldSocketPath = path.join(confDir, "ECRSESSIONSOCKFILE");
  const nonSocketPath = path.join(confDir, "AgentProxyConfig_demo");
  let heldServer;

  await fs.mkdir(path.dirname(appExecutable), { recursive: true });
  await fs.mkdir(confDir, { recursive: true });
  await createOrphanSocket(orphanSocketPath);
  heldServer = net.createServer();
  await new Promise((resolve, reject) => {
    heldServer.listen(heldSocketPath, resolve).once("error", reject);
  });
  await fs.writeFile(nonSocketPath, "not a socket");

  try {
    const runtime = new EasyConnectRuntime({ appExecutable });
    const result = await runtime.clearStaleLocalServiceSockets();

    assert.deepEqual(
      result.entries.map(({ name, action }) => ({ name, action })),
      [
        { name: "ECDomainFile", action: "deleted" },
        { name: "ECRSESSIONSOCKFILE", action: "held" },
      ],
    );
    assert.equal(await pathExists(orphanSocketPath), false);
    assert.equal(await pathExists(heldSocketPath), true);
    assert.equal(await pathExists(nonSocketPath), true);
  } finally {
    if (heldServer) {
      await new Promise((resolve) => heldServer.close(resolve));
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("waitForOnlineStatus attaches local service diagnostics on timeout", async () => {
  class TestRuntime extends EasyConnectRuntime {
    async describeActiveSession() {
      return {};
    }

    async collectRecoveryDiagnostics() {
      return {
        classification: "local-service-not-ready",
        officialLogs: {
          csclient: [
            "[2026-05-12 09:35:26][E][Run][cs] local service setup timeout, begin to logout.",
          ],
          localServiceManager: [
            "[2026-05-12 09:35:26][ERROR]LocalServiceConfManager",
          ],
        },
      };
    }
  }

  const runtime = new TestRuntime();

  await assert.rejects(
    async () =>
      runtime.waitForOnlineStatus({
        timeoutMs: 5,
        pollMs: 1,
      }),
    (error) => {
      assert.equal(error.code, "EASYCONNECT_LOCAL_SERVICE_NOT_READY");
      assert.equal(error.diagnostics.classification, "local-service-not-ready");
      assert.match(error.message, /local service did not become ready/i);
      assert.match(error.diagnostics.officialLogs.csclient[0], /local service setup timeout/);
      return true;
    },
  );
});

test("waitForOnlineStatus stops early when EasyConnect reports same-user private kick", async () => {
  class TestRuntime extends EasyConnectRuntime {
    async describeActiveSession() {
      return { token: "token-1", sessionId: "session-1" };
    }

    async getLoginStatus() {
      return {
        status: "3",
        logoutReasonDecoded: {
          data: {
            reason: "LOGOUT_PRIVATEKICK",
            msg: "private same username login",
            data: {
              initiator_clientip: "203.0.113.55",
            },
          },
        },
      };
    }

    async getServiceState() {
      return {
        allService: "2",
        l3vpn: "2",
        tcp: "2",
      };
    }
  }

  await assert.rejects(
    async () =>
      new TestRuntime().waitForOnlineStatus({
        timeoutMs: 1000,
        pollMs: 1,
      }),
    (error) => {
      assert.equal(error.code, "EASYCONNECT_PRIVATE_KICK");
      assert.equal(error.loginStatus.logoutReasonDecoded.data.reason, "LOGOUT_PRIVATEKICK");
      assert.equal(error.serviceState.allService, "2");
      assert.match(error.message, /same username login/i);
      return true;
    },
  );
});

test("recoverLoginViaPageBridge ignores stale preflight private kick and attempts a fresh login", async () => {
  const calls = [];

  class TestRuntime extends EasyConnectRuntime {
    async describeActiveSession() {
      calls.push("describeActiveSession");
      return {};
    }

    async getLoginStatus() {
      calls.push("getLoginStatus");
      return {
        status: "3",
        logoutReasonDecoded: {
          data: {
            reason: "LOGOUT_PRIVATEKICK",
            msg: "private same username login",
          },
        },
      };
    }

    async getServiceState() {
      calls.push("getServiceState");
      return {
        allService: "2",
      };
    }

    async recoverViaUserMode() {
      calls.push("recoverViaUserMode");
      return { mode: "user" };
    }

    async openPortalLoginTarget() {
      calls.push("openPortalLoginTarget");
      return { id: "login-target" };
    }

    async waitForOnlineStatus() {
      calls.push("waitForOnlineStatus");
      return null;
    }

    async syncPortalGlobalState() {
      calls.push("syncPortalGlobalState");
      return { ok: true };
    }

    async writePortalCookie() {
      calls.push("writePortalCookie");
      return { ok: true };
    }

    async navigatePortalRoute() {
      calls.push("navigatePortalRoute");
      return { ok: true };
    }

    async waitForRemoteDebugTarget() {
      calls.push("waitForRemoteDebugTarget");
      return { id: "service-target" };
    }

    async bootstrapViaPageBridge() {
      calls.push("bootstrapViaPageBridge");
      return { ok: true };
    }

    async startCoreServices() {
      calls.push("startCoreServices");
      return { ok: true };
    }

    async reloadPortalTarget() {
      calls.push("reloadPortalTarget");
      return { ok: true };
    }
  }

  const result = await new TestRuntime().recoverLoginViaPageBridge({
    gatewayLogin: {
      async loginPasswordSession() {
        calls.push("loginPasswordSession");
        return {
          effectiveTwfId: "session-1",
          login: {
            summary: { ok: true },
          },
          config: {
            summary: {},
          },
        };
      },
    },
    gatewayHost: "198.51.100.20",
    gatewayPort: 9898,
    username: "demo-user",
    password: "secret",
    officialAutoLoginTimeoutMs: 0,
    serviceReloadSettleMs: 0,
  });

  assert.equal(calls.includes("loginPasswordSession"), true);
  assert.equal(calls.includes("recoverViaUserMode"), true);
  assert.equal(result.loginSummary.ok, true);
});

test("recoverLoginViaPageBridge uses official renderer login before backend session graft", async () => {
  const calls = [];
  const phases = [];

  class TestRuntime extends EasyConnectRuntime {
    async describeActiveSession() {
      calls.push("describeActiveSession");
      return {};
    }

    async recoverViaUserMode() {
      calls.push("recoverViaUserMode");
      return { mode: "user" };
    }

    async openPortalLoginTarget() {
      calls.push("openPortalLoginTarget");
      return { id: "login-target" };
    }

    async waitForOnlineStatus(options) {
      calls.push(["waitForOnlineStatus", options.timeoutMs]);
      if (options.timeoutMs === 5) {
        throw new Error("official auto-login did not finish in time");
      }

      return {
        activeSession: { sessionId: "official-renderer-session" },
        loginStatus: { status: "1" },
        serviceState: { base: "18" },
      };
    }

    async triggerPortalOfficialPasswordLogin(options) {
      calls.push([
        "triggerPortalOfficialPasswordLogin",
        options.username,
        options.gatewayHost,
        options.gatewayPort,
        options.remoteDebugPort,
      ]);
      return {
        ok: true,
        auth: {
          code: 1,
          twfIDLength: 16,
        },
      };
    }

    async navigatePortalRoute() {
      calls.push("navigatePortalRoute");
      return { ok: true };
    }

    async waitForRemoteDebugTarget(targetUrlPart) {
      calls.push(["waitForRemoteDebugTarget", targetUrlPart]);
      return { id: "service-target", url: targetUrlPart };
    }

    async startOfficialPortalService(targetUrlPart, options) {
      calls.push(["startOfficialPortalService", targetUrlPart, options.remoteDebugPort, options.username]);
      return { ok: true };
    }

    async startCoreServices() {
      calls.push("startCoreServices");
      throw new Error("external core scripts should not be the first service start path after official renderer login");
    }

    async reloadPortalTarget() {
      calls.push("reloadPortalTarget");
      return { ok: true };
    }
  }

  const runtime = new TestRuntime();
  const result = await runtime.recoverLoginViaPageBridge({
    gatewayLogin: {
      async loginPasswordSession() {
        calls.push("loginPasswordSession");
        throw new Error("backend session graft should not run when official renderer login succeeds");
      },
    },
    gatewayHost: "198.51.100.20",
    gatewayPort: 9898,
    username: "demo-user",
    password: "secret",
    remoteDebugPort: 9222,
    officialAutoLoginTimeoutMs: 5,
    officialRendererLoginOnlineTimeoutMs: 500,
    serviceReloadSettleMs: 0,
    onPhase: (phase) => phases.push(phase),
  });

  assert.equal(result.mode, "official-renderer-login");
  assert.equal(result.online.activeSession.sessionId, "official-renderer-session");
  assert.equal(result.officialRendererLogin.auth.code, 1);
  assert.equal(calls.includes("loginPasswordSession"), false);
  assert.equal(calls.includes("syncPortalGlobalState"), false);
  assert.deepEqual(
    calls.filter((call) => Array.isArray(call) && call[0] === "triggerPortalOfficialPasswordLogin"),
    [["triggerPortalOfficialPasswordLogin", "demo-user", "198.51.100.20", 9898, 9222]],
  );
  assert.deepEqual(
    calls.filter((call) => Array.isArray(call) && call[0] === "startOfficialPortalService"),
    [["startOfficialPortalService", "/portal/#!/service", 9222, "demo-user"]],
  );
  assert.deepEqual(phases.slice(-5), [
    "official-renderer-login",
    "navigate-service-after-official-renderer-login",
    "start-official-portal-service-after-official-renderer-login",
    "wait-online-after-official-renderer-login",
    "refresh-service-page",
  ]);
});

test("recoverLoginViaPageBridge refreshes the service page after VPN is online", async () => {
  const calls = [];
  const phases = [];

  class TestRuntime extends EasyConnectRuntime {
    async describeActiveSession() {
      calls.push("describeActiveSession");
      return {};
    }

    async getLoginStatus() {
      calls.push("getLoginStatus");
      return { status: "0" };
    }

    async getServiceState() {
      calls.push("getServiceState");
      return {};
    }

    async recoverViaUserMode(options) {
      calls.push(["recoverViaUserMode", options]);
      return { mode: "user" };
    }

    async openPortalLoginTarget(gatewayHost, gatewayPort, targetUrlPart, options) {
      calls.push(["openPortalLoginTarget", gatewayHost, gatewayPort, targetUrlPart, options.remoteDebugPort]);
      return { id: "login-target" };
    }

    async syncPortalGlobalState(targetUrlPart, context, options) {
      calls.push(["syncPortalGlobalState", targetUrlPart, options.profile, context.passwordConfigSummary]);
      return { targetUrlPart, sessionId: context.sessionId };
    }

    async writePortalCookie(targetUrlPart, name, value, options) {
      calls.push(["writePortalCookie", targetUrlPart, name, value, options.path]);
      return { ok: true };
    }

    async navigatePortalRoute(targetUrlPart, targetUrl, options) {
      calls.push(["navigatePortalRoute", targetUrlPart, targetUrl, options.remoteDebugPort]);
      return { ok: true };
    }

    async waitForRemoteDebugTarget(targetUrlPart, options) {
      calls.push(["waitForRemoteDebugTarget", targetUrlPart, options.remoteDebugPort]);
      return { id: "service-target", url: targetUrlPart };
    }

    async bootstrapViaPageBridge(targetUrlPart, context, options) {
      calls.push(["bootstrapViaPageBridge", targetUrlPart, context.sessionId, options.remoteDebugPort]);
      return { ok: true };
    }

    async startCoreServices(options) {
      calls.push(["startCoreServices", options.gatewayHost, options.gatewayPort, options.username]);
      return { svpnservice: { ok: true }, csclient: { ok: true } };
    }

    async waitForOnlineStatus(options) {
      calls.push(["waitForOnlineStatus", options.timeoutMs, options.pollMs]);
      return {
        activeSession: { sessionId: "session-1" },
        loginStatus: { status: "1" },
        serviceState: { base: "18" },
      };
    }

    async reloadPortalTarget(targetUrlPart, options) {
      calls.push(["reloadPortalTarget", targetUrlPart, options.remoteDebugPort]);
      return { ok: true, href: "https://203.0.113.10:9898/portal/#!/service" };
    }
  }

  const runtime = new TestRuntime();
  const result = await runtime.recoverLoginViaPageBridge({
    gatewayLogin: {
      async loginPasswordSession() {
        calls.push("loginPasswordSession");
        return {
          effectiveTwfId: "session-1",
          login: {
            summary: { ok: true },
          },
          config: {
            summary: {
              midAtkCheck: "1",
              nextService: "auth/psw",
            },
          },
        };
      },
    },
    gatewayHost: "203.0.113.10",
    gatewayPort: 9898,
    username: "demo-user",
    password: "secret",
    remoteDebugPort: 9222,
    officialAutoLoginTimeoutMs: 0,
    serviceReloadSettleMs: 0,
    onPhase: (phase) => phases.push(phase),
  });

  assert.deepEqual(result.serviceReload, {
    ok: true,
    href: "https://203.0.113.10:9898/portal/#!/service",
  });
  assert.equal(result.online.loginStatus.status, "1");
  assert.deepEqual(
    calls
      .filter((call) => Array.isArray(call) && call[0] === "syncPortalGlobalState")
      .map((call) => call[3]),
    [
      { midAtkCheck: "1", nextService: "auth/psw" },
      { midAtkCheck: "1", nextService: "auth/psw" },
    ],
  );

  const waitOnlineIndex = calls.findIndex((call) => Array.isArray(call) && call[0] === "waitForOnlineStatus");
  const startCoreIndex = calls.findIndex((call) => Array.isArray(call) && call[0] === "startCoreServices");
  const bootstrapIndex = calls.findIndex((call) => Array.isArray(call) && call[0] === "bootstrapViaPageBridge");
  const reloadIndex = calls.findIndex((call) => Array.isArray(call) && call[0] === "reloadPortalTarget");
  let postRefreshWaitIndex = -1;
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const call = calls[index];
    if (Array.isArray(call) && call[0] === "waitForRemoteDebugTarget") {
      postRefreshWaitIndex = index;
      break;
    }
  }

  assert.ok(waitOnlineIndex >= 0);
  assert.ok(startCoreIndex > bootstrapIndex);
  assert.ok(waitOnlineIndex > startCoreIndex);
  assert.ok(reloadIndex > waitOnlineIndex);
  assert.ok(postRefreshWaitIndex > reloadIndex);
  assert.deepEqual(phases.slice(-4), [
    "start-core-services",
    "wait-online",
    "refresh-service-page",
    "wait-service-target-after-refresh",
  ]);
});

test("openPortalLoginTarget relaunches when the existing login target is not responsive", async () => {
  const calls = [];

  class TestRuntime extends EasyConnectRuntime {
    constructor() {
      super();
      this.waitLoginCount = 0;
      this.waitAnyCount = 0;
    }

    async waitForRemoteDebugTarget(targetUrlPart, options) {
      calls.push(["waitForRemoteDebugTarget", targetUrlPart, options.remoteDebugPort]);
      this.waitLoginCount += 1;
      return {
        id: `login-target-${this.waitLoginCount}`,
        url: `https://198.51.100.20:9898${targetUrlPart}`,
        title: this.waitLoginCount === 1 ? "Loading..." : "EasyConnect",
      };
    }

    async ensureRemoteDebugPageTargetResponsive(target) {
      calls.push(["ensureRemoteDebugPageTargetResponsive", target.id]);
      if (target.id === "login-target-1") {
        throw new Error("Timed out waiting for WebSocket message");
      }
      return true;
    }

    async waitForPortalLoginAuthBridgeReady(targetUrlPart, options) {
      calls.push(["waitForPortalLoginAuthBridgeReady", targetUrlPart, options.remoteDebugPort]);
      const target = await this.waitForRemoteDebugTarget(targetUrlPart, options);
      if (target.id === "login-target-1") {
        const error = new Error("Timed out waiting for official login auth bridge");
        error.code = "EASYCONNECT_OFFICIAL_LOGIN_TARGET_NOT_READY";
        throw error;
      }
      return {
        ...target,
        authBridgeProbe: {
          hasAuth: true,
          hasSFAPI: true,
          hasSetting: true,
          hasSession: true,
        },
      };
    }

    async waitForAnyRemoteDebugPageTarget() {
      calls.push("waitForAnyRemoteDebugPageTarget");
      this.waitAnyCount += 1;
      return { id: `fallback-target-${this.waitAnyCount}`, url: "file:///connect.html" };
    }

    async navigateRemoteDebugPageTarget(target, targetUrl) {
      calls.push(["navigateRemoteDebugPageTarget", target.id, targetUrl]);
      if (target.id === "fallback-target-1") {
        throw new Error("Timed out waiting for WebSocket message");
      }
      return { ok: true, requestedUrl: targetUrl };
    }

    async recoverViaUserMode(options) {
      calls.push(["recoverViaUserMode", options.remoteDebugPort]);
      return { mode: "user" };
    }
  }

  const runtime = new TestRuntime();
  const result = await runtime.openPortalLoginTarget("198.51.100.20", 9898, "/portal/#!/login", {
    remoteDebugPort: 9222,
    timeoutMs: 1000,
  });

  assert.equal(result.id, "login-target-3");
  assert.equal(result.recovery.mode, "user");
  assert.match(result.staleTargetError, /WebSocket message/);
  assert.deepEqual(
    calls.filter((call) => Array.isArray(call) && call[0] === "recoverViaUserMode"),
    [["recoverViaUserMode", 9222]],
  );
});

test("openPortalLoginTarget navigates from gateway page with CDP Page.navigate", async () => {
  const calls = [];

  class TestRuntime extends EasyConnectRuntime {
    constructor() {
      super();
      this.loginTargetReady = false;
    }

    async waitForRemoteDebugTarget(targetUrlPart, options) {
      calls.push(["waitForRemoteDebugTarget", targetUrlPart, options.remoteDebugPort]);
      if (!this.loginTargetReady) {
        throw new Error(`Timed out waiting for devtools target: ${targetUrlPart}`);
      }

      return {
        id: "login-target",
        url: `https://198.51.100.20:9898${targetUrlPart}`,
        title: "EasyConnect",
      };
    }

    async ensureRemoteDebugPageTargetResponsive(target) {
      calls.push(["ensureRemoteDebugPageTargetResponsive", target.id]);
      return true;
    }

    async waitForAnyRemoteDebugPageTarget() {
      calls.push("waitForAnyRemoteDebugPageTarget");
      return {
        id: "gateway-target",
        url: "file:///Applications/EasyConnect.app/Contents/Resources/app.asar/../Web/local/connect/connect.html",
        title: "EasyConnect",
      };
    }

    async navigateRemoteDebugPageTarget(target, targetUrl) {
      calls.push(["navigateRemoteDebugPageTarget", target.id, targetUrl]);
      this.loginTargetReady = true;
      return { ok: true, requestedUrl: targetUrl };
    }

    async waitForPortalLoginAuthBridgeReady(targetUrlPart, options) {
      calls.push(["waitForPortalLoginAuthBridgeReady", targetUrlPart, options.remoteDebugPort]);
      const target = await this.waitForRemoteDebugTarget(targetUrlPart, options);
      return {
        ...target,
        authBridgeProbe: {
          hasAuth: true,
          hasSFAPI: true,
          hasSetting: true,
          hasSession: true,
        },
      };
    }
  }

  const runtime = new TestRuntime();
  const result = await runtime.openPortalLoginTarget("198.51.100.20", 9898, "/portal/#!/login", {
    remoteDebugPort: 9222,
    timeoutMs: 1000,
  });

  assert.equal(result.id, "login-target");
  assert.deepEqual(
    calls.filter((call) => Array.isArray(call) && call[0] === "navigateRemoteDebugPageTarget"),
    [["navigateRemoteDebugPageTarget", "gateway-target", "https://198.51.100.20:9898/portal/#!/login"]],
  );
  assert.equal(
    calls.some((call) => Array.isArray(call) && call[0] === "ensureRemoteDebugPageTargetResponsive"),
    true,
  );
});

test("openPortalLoginTarget waits for the official auth bridge instead of accepting a Loading login URL", async () => {
  const calls = [];

  class TestRuntime extends EasyConnectRuntime {
    constructor() {
      super();
      this.loginTargetReady = false;
    }

    async waitForRemoteDebugTarget(targetUrlPart, options) {
      calls.push(["waitForRemoteDebugTarget", targetUrlPart, options.remoteDebugPort]);
      if (!this.loginTargetReady) {
        throw new Error(`Timed out waiting for devtools target: ${targetUrlPart}`);
      }

      return {
        id: "login-target",
        url: `https://198.51.100.20:9898${targetUrlPart}`,
        title: "Loading...",
        webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/login-target",
      };
    }

    async ensureRemoteDebugPageTargetResponsive(target) {
      calls.push(["ensureRemoteDebugPageTargetResponsive", target.id]);
      return true;
    }

    async waitForPortalLoginAuthBridgeReady(targetUrlPart, options) {
      calls.push(["waitForPortalLoginAuthBridgeReady", targetUrlPart, options.remoteDebugPort]);
      return {
        id: "login-target",
        url: `https://198.51.100.20:9898${targetUrlPart}`,
        title: "EasyConnect",
        authBridgeProbe: {
          hasAuth: true,
          hasSFAPI: true,
          hasSetting: true,
          hasSession: true,
        },
      };
    }

    async waitForAnyRemoteDebugPageTarget() {
      calls.push("waitForAnyRemoteDebugPageTarget");
      return {
        id: "gateway-target",
        url: "file:///Applications/EasyConnect.app/Contents/Resources/Web/local/connect/connect.html",
        title: "EasyConnect",
      };
    }

    async navigateRemoteDebugPageTarget(target, targetUrl) {
      calls.push(["navigateRemoteDebugPageTarget", target.id, targetUrl]);
      this.loginTargetReady = true;
      return { ok: true, requestedUrl: targetUrl };
    }
  }

  const runtime = new TestRuntime();
  const result = await runtime.openPortalLoginTarget("198.51.100.20", 9898, "/portal/#!/login", {
    remoteDebugPort: 9222,
    timeoutMs: 1000,
  });

  assert.equal(result.id, "login-target");
  assert.deepEqual(
    calls.filter((call) => Array.isArray(call) && call[0] === "waitForPortalLoginAuthBridgeReady"),
    [["waitForPortalLoginAuthBridgeReady", "/portal/#!/login", 9222]],
  );
});

test("triggerPortalOfficialPasswordLogin refuses to run on a non-login page even when SF.auth exists", async () => {
  const calls = [];

  class TestRuntime extends EasyConnectRuntime {
    async waitForPortalLoginAuthBridgeReady() {
      calls.push("waitForPortalLoginAuthBridgeReady");
      const error = new Error("Timed out waiting for official login auth bridge");
      error.code = "EASYCONNECT_OFFICIAL_LOGIN_TARGET_NOT_READY";
      error.lastProbe = {
        href: "file:///Applications/EasyConnect.app/Contents/Resources/Web/local/connect_notfound/connect_notfound.html",
        title: "EasyConnect",
        hasAuth: true,
        hasSFAPI: true,
        hasSetting: true,
        hasSession: true,
      };
      throw error;
    }

    async evaluateOnRemoteDebugPageTarget() {
      calls.push("evaluateOnRemoteDebugPageTarget");
      return {};
    }
  }

  const runtime = new TestRuntime();

  await assert.rejects(
    () => runtime.triggerPortalOfficialPasswordLogin({
      username: "demo-user",
      password: "secret",
      timeoutMs: 10,
    }),
    (error) => error.code === "EASYCONNECT_OFFICIAL_LOGIN_TARGET_NOT_READY",
  );
  assert.deepEqual(calls, ["waitForPortalLoginAuthBridgeReady"]);
});

test("recoverLoginViaPageBridge lets official auto-login win before backend password login", async () => {
  const calls = [];
  const phases = [];

  class TestRuntime extends EasyConnectRuntime {
    async describeActiveSession() {
      calls.push("describeActiveSession");
      return {};
    }

    async getLoginStatus() {
      calls.push("getLoginStatus");
      return { status: "0" };
    }

    async getServiceState() {
      calls.push("getServiceState");
      return {};
    }

    async recoverViaUserMode() {
      calls.push("recoverViaUserMode");
      return { mode: "user" };
    }

    async openPortalLoginTarget() {
      calls.push("openPortalLoginTarget");
      return { id: "login-target" };
    }

    async waitForOnlineStatus(options) {
      calls.push(["waitForOnlineStatus", options.timeoutMs, options.pollMs]);
      return {
        activeSession: { sessionId: "official-session" },
        loginStatus: { status: "1" },
        serviceState: { base: "18" },
      };
    }
  }

  const runtime = new TestRuntime();
  const result = await runtime.recoverLoginViaPageBridge({
    gatewayLogin: {
      async loginPasswordSession() {
        calls.push("loginPasswordSession");
        throw new Error("backend login should not run when official auto-login succeeds");
      },
    },
    gatewayHost: "198.51.100.20",
    gatewayPort: 9898,
    username: "demo-user",
    password: "secret",
    officialAutoLoginTimeoutMs: 50,
    statusPollMs: 5,
    onPhase: (phase) => phases.push(phase),
  });

  assert.equal(result.mode, "official-auto-login");
  assert.equal(result.online.activeSession.sessionId, "official-session");
  assert.equal(calls.includes("loginPasswordSession"), false);
  assert.deepEqual(phases.slice(-2), ["wait-official-auto-login", "official-auto-login-online"]);
});

test("recoverLoginViaPageBridge retries core services once after local service readiness failure", async () => {
  const calls = [];
  const phases = [];

  class TestRuntime extends EasyConnectRuntime {
    async describeActiveSession() {
      return {};
    }

    async getLoginStatus() {
      return { status: "0" };
    }

    async getServiceState() {
      return {};
    }

    async recoverViaUserMode() {
      calls.push("recoverViaUserMode");
      return { mode: "user" };
    }

    async openPortalLoginTarget() {
      calls.push("openPortalLoginTarget");
      return { id: "login-target" };
    }

    async syncPortalGlobalState(targetUrlPart, context, options) {
      calls.push(["syncPortalGlobalState", targetUrlPart, options.profile]);
      return { targetUrlPart, sessionId: context.sessionId };
    }

    async writePortalCookie() {
      calls.push("writePortalCookie");
      return { ok: true };
    }

    async navigatePortalRoute() {
      calls.push("navigatePortalRoute");
      return { ok: true };
    }

    async waitForRemoteDebugTarget(targetUrlPart) {
      calls.push(["waitForRemoteDebugTarget", targetUrlPart]);
      return { id: "service-target", url: targetUrlPart };
    }

    async bootstrapViaPageBridge() {
      calls.push("bootstrapViaPageBridge");
      return { ok: true };
    }

    async startCoreServices() {
      calls.push("startCoreServices");
      return { started: calls.filter((call) => call === "startCoreServices").length };
    }

    async killCoreServiceProcesses() {
      calls.push("killCoreServiceProcesses");
      return { commands: ["CSClient", "svpnservice"], forced: true, remaining: { csclient: [], svpnservice: [] } };
    }

    async resetAgentProxy() {
      calls.push("resetAgentProxy");
      return { label: "com.sangfor.ECAgentProxy", forced: true, processes: { ecAgentProxy: [] } };
    }

    async waitForOnlineStatus() {
      calls.push("waitForOnlineStatus");
      if (calls.filter((call) => call === "waitForOnlineStatus").length === 1) {
        const error = new Error("Local service did not become ready before online status timeout");
        error.code = "EASYCONNECT_LOCAL_SERVICE_NOT_READY";
        error.diagnostics = { classification: "local-service-not-ready" };
        throw error;
      }

      return {
        activeSession: { sessionId: "session-1" },
        loginStatus: { status: "1" },
        serviceState: { base: "18" },
      };
    }

    async reloadPortalTarget() {
      calls.push("reloadPortalTarget");
      return { ok: true, href: "https://198.51.100.20:9898/portal/#!/service" };
    }
  }

  const runtime = new TestRuntime();
  const result = await runtime.recoverLoginViaPageBridge({
    gatewayLogin: {
      async loginPasswordSession() {
        calls.push("loginPasswordSession");
        return {
          effectiveTwfId: "session-1",
          login: { summary: { ok: true } },
          config: { summary: { nextService: "auth/psw" } },
        };
      },
    },
    gatewayHost: "198.51.100.20",
    gatewayPort: 9898,
    username: "demo-user",
    password: "secret",
    officialAutoLoginTimeoutMs: 0,
    serviceReloadSettleMs: 0,
    onPhase: (phase) => phases.push(phase),
  });

  assert.equal(result.online.loginStatus.status, "1");
  assert.equal(result.coreServices.retryReason, "local-service-not-ready");
  assert.equal(calls.filter((call) => call === "startCoreServices").length, 2);
  assert.equal(calls.filter((call) => call === "killCoreServiceProcesses").length, 1);
  assert.equal(calls.filter((call) => call === "resetAgentProxy").length, 1);
  assert.equal(calls.filter((call) => call === "waitForOnlineStatus").length, 2);
  assert.ok(phases.includes("recover-local-service-not-ready"));
});

test("recoverLoginViaPageBridge stops local service retry when ECAgentProxy is still not ready", async () => {
  const calls = [];

  class TestRuntime extends EasyConnectRuntime {
    async describeActiveSession() {
      return {};
    }

    async getLoginStatus() {
      return { status: "0" };
    }

    async getServiceState() {
      return {};
    }

    async recoverViaUserMode() {
      calls.push("recoverViaUserMode");
      return { agentProxyReady: { ok: true } };
    }

    async openPortalLoginTarget() {
      calls.push("openPortalLoginTarget");
      return { id: "login-target" };
    }

    async syncPortalGlobalState() {
      calls.push("syncPortalGlobalState");
      return { ok: true };
    }

    async writePortalCookie() {
      calls.push("writePortalCookie");
      return { ok: true };
    }

    async navigatePortalRoute() {
      calls.push("navigatePortalRoute");
      return { ok: true };
    }

    async waitForRemoteDebugTarget() {
      calls.push("waitForRemoteDebugTarget");
      return { id: "target" };
    }

    async bootstrapViaPageBridge() {
      calls.push("bootstrapViaPageBridge");
      return { ok: true };
    }

    async startCoreServices() {
      calls.push("startCoreServices");
      return { ok: true };
    }

    async waitForOnlineStatus() {
      calls.push("waitForOnlineStatus");
      const error = new Error("Local service did not become ready before online status timeout");
      error.code = "EASYCONNECT_LOCAL_SERVICE_NOT_READY";
      error.diagnostics = { classification: "local-service-not-ready" };
      throw error;
    }

    async killCoreServiceProcesses() {
      calls.push("killCoreServiceProcesses");
      return {};
    }

    async resetAgentProxy() {
      calls.push("resetAgentProxy");
      return { finalState: { ok: false, running: false, state: "spawn scheduled" } };
    }

    async waitForAgentProxyReady() {
      calls.push("waitForAgentProxyReady");
      const error = new Error("ECAgentProxy did not become ready");
      error.code = "EASYCONNECT_AGENT_PROXY_NOT_READY";
      throw error;
    }
  }

  await assert.rejects(
    () =>
      new TestRuntime().recoverLoginViaPageBridge({
        gatewayLogin: {
          async loginPasswordSession() {
            return {
              effectiveTwfId: "session-1",
              login: { summary: { ok: true } },
              config: { summary: { nextService: "auth/psw" } },
            };
          },
        },
        gatewayHost: "198.51.100.20",
        gatewayPort: 9898,
        username: "demo-user",
        password: "secret",
        officialAutoLoginTimeoutMs: 0,
        serviceReloadSettleMs: 0,
      }),
    (error) => error.code === "EASYCONNECT_AGENT_PROXY_NOT_READY",
  );
  assert.equal(calls.filter((call) => call === "startCoreServices").length, 1);
  assert.deepEqual(calls.slice(-3), [
    "killCoreServiceProcesses",
    "resetAgentProxy",
    "waitForAgentProxyReady",
  ]);
});

test("ensureOnline exposes service page reload evidence from the recovery chain", async () => {
  const serviceReload = { ok: true, href: "https://203.0.113.10:9898/portal/#!/service" };
  const coreServices = {
    staleLocalServiceSockets: {
      entries: [{ name: "ECDomainFile", action: "deleted" }],
    },
  };
  const result = await ensureOnline({
    runtime: {
      async describeActiveSession() {
        return {};
      },
      async recoverLoginViaPageBridge() {
        return {
          recovery: { mode: "user" },
          loginSummary: { ok: true },
          bridge: { ok: true },
          coreServices,
          serviceReload,
          online: { loginStatus: { status: "1" } },
        };
      },
    },
    gatewayLogin: {
      async loginAuth() {
        return { ok: true };
      },
      async passwordConfig() {
        return { summary: { useRandCode: "0" } };
      },
    },
    gatewayHost: "203.0.113.10",
    gatewayPort: 9898,
    username: "demo-user",
    password: "secret",
  });

  assert.equal(result.action, "relogin-page-bridge");
  assert.deepEqual(result.serviceReload, serviceReload);
  assert.deepEqual(result.coreServices, coreServices);
});
