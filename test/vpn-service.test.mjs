import test from "node:test";
import assert from "node:assert/strict";

import { VpnService } from "../src/services/vpn-service.js";

test("VpnService.getDebugTargets redacts remote-debug credentials at the service boundary", async () => {
  const service = new VpnService({
    runtimeFactory: () => ({
      async getRemoteDebugTargets() {
        return [
          {
            id: "page-1",
            url: "https://gateway.example/portal/?twfid=twf-secret&token=url-secret",
            webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/socket-secret",
            sessionId: "full-session-secret",
            token: "plain-token-secret",
          },
        ];
      },
    }),
  });

  const targets = await service.getDebugTargets({}, 9222);
  const serialized = JSON.stringify(targets);
  for (const secret of [
    "twf-secret",
    "url-secret",
    "socket-secret",
    "full-session-secret",
    "plain-token-secret",
  ]) {
    assert.equal(serialized.includes(secret), false, `${secret} must be redacted`);
  }
});

test("VpnService.getSnapshot reuses one runtime and returns combined status/info", async () => {
  const calls = [];
  const dataPlaneProbe = {
    configured: true,
    ok: true,
    state: "reachable",
    target: "tcp://192.168.150.199:1521",
  };
  const fakeRuntime = {
    async describeActiveSession() {
      calls.push("describeActiveSession");
      return {
        token: "secret-token",
        tokenRedacted: "secret...oken",
        sessionId: "session-1",
        derivedTokenMatches: true,
      };
    },
    async getLoginStatus(token) {
      calls.push(["getLoginStatus", token]);
      return { status: "1" };
    },
    async getServiceState(token) {
      calls.push(["getServiceState", token]);
      return { base: "18" };
    },
    async getLocalRuntimeInfo(token) {
      calls.push(["getLocalRuntimeInfo", token]);
      return { enableAutoLogin: 0 };
    },
    async getBundleSettingPath() {
      calls.push("getBundleSettingPath");
      return "/Applications/EasyConnect.app/Contents/Resources/conf/setting_demo.json";
    },
    async getPort() {
      calls.push("getPort");
      return 54530;
    },
    async describeLatestCachedToken() {
      calls.push("describeLatestCachedToken");
      return {
        token: "cached-token",
        tokenRedacted: "cached...oken",
        loginStatus: { status: "1" },
      };
    },
    async getGatewayCandidates() {
      calls.push("getGatewayCandidates");
      return [{ host: "203.0.113.10", port: 9898 }];
    },
    appExecutable: "/Applications/EasyConnect.app/Contents/MacOS/EasyConnect",
  };

  const service = new VpnService({
    runtimeFactory: () => fakeRuntime,
    existsFn: async () => true,
    dataPlaneProbeFn: async (config) => {
      calls.push(["probeDataPlane", config.vpn.dataPlaneProbeTarget]);
      return dataPlaneProbe;
    },
  });

  const snapshot = await service.getSnapshot({
    vpn: {
      appExecutable: fakeRuntime.appExecutable,
      dataPlaneProbeTarget: "tcp://192.168.150.199:1521",
    },
  });

  assert.equal(snapshot.status.activeSession.token, undefined);
  assert.equal(snapshot.environmentInfo.activeSession.token, undefined);
  assert.deepEqual(snapshot.status.loginStatus, { status: "1" });
  assert.deepEqual(snapshot.status.dataPlane, dataPlaneProbe);
  assert.equal(snapshot.environmentInfo.latestCachedToken, null);
  assert.deepEqual(snapshot.environmentInfo.gatewayCandidates, [{ host: "203.0.113.10", port: 9898 }]);
  assert.equal(calls.filter((item) => item === "describeActiveSession").length, 1);
  assert.equal(calls.includes("describeLatestCachedToken"), false);
});

test("VpnService.getSnapshot skips data-plane network IO while the control plane is offline", async () => {
  let probeCalls = 0;
  const fakeRuntime = {
    async describeActiveSession() {
      return {
        token: "secret-token",
        sessionId: "session-1",
      };
    },
    async getLoginStatus() {
      return { status: "3" };
    },
    async getServiceState() {
      return { base: "0" };
    },
    async getLocalRuntimeInfo() {
      return {};
    },
    async getBundleSettingPath() {
      return null;
    },
    async getPort() {
      return null;
    },
    async getGatewayCandidates() {
      return [];
    },
    appExecutable: "/Applications/EasyConnect.app/Contents/MacOS/EasyConnect",
  };
  const service = new VpnService({
    runtimeFactory: () => fakeRuntime,
    existsFn: async () => true,
    dataPlaneProbeFn: async () => {
      probeCalls += 1;
      return { configured: true, ok: true, state: "reachable" };
    },
  });

  const snapshot = await service.getSnapshot({
    vpn: {
      dataPlaneProbeTarget: "tcp://192.168.150.199:1521",
    },
  });

  assert.equal(probeCalls, 0);
  assert.deepEqual(snapshot.status.dataPlane, {
    configured: true,
    ok: null,
    state: "control-plane-offline",
    target: "tcp://192.168.150.199:1521",
  });
});

test("VpnService.getEnvironmentInfo does not run a data-plane probe", async () => {
  const fakeRuntime = {
    async describeActiveSession() {
      return { token: "secret-token", sessionId: "session-1" };
    },
    async getLoginStatus() {
      return { status: "1" };
    },
    async getServiceState() {
      return { base: "18", l3vpn: "18", tcp: "43" };
    },
    async getLocalRuntimeInfo() {
      return {};
    },
    async getBundleSettingPath() {
      return null;
    },
    async getPort() {
      return null;
    },
    async getGatewayCandidates() {
      return [];
    },
    appExecutable: "/Applications/EasyConnect.app/Contents/MacOS/EasyConnect",
  };
  const service = new VpnService({
    runtimeFactory: () => fakeRuntime,
    existsFn: async () => true,
    dataPlaneProbeFn: async () => {
      throw new Error("environment-only reads must not touch the probe target");
    },
  });

  const info = await service.getEnvironmentInfo({
    vpn: { dataPlaneProbeTarget: "tcp://192.0.2.10:1521" },
  });

  assert.equal(info.appExecutable, fakeRuntime.appExecutable);
});

test("VpnService.getSnapshot reports latest cached token only when no active session exists", async () => {
  const fakeRuntime = {
    async describeActiveSession() {
      return null;
    },
    async describeLatestCachedToken() {
      return {
        token: "cached-token",
        tokenRedacted: "cached...oken",
        loginStatus: { status: "1" },
      };
    },
    async getBundleSettingPath() {
      return "/Applications/EasyConnect.app/Contents/Resources/conf/setting_demo.json";
    },
    async getPort() {
      return 54530;
    },
    async getGatewayCandidates() {
      return [];
    },
    appExecutable: "/Applications/EasyConnect.app/Contents/MacOS/EasyConnect",
  };

  const service = new VpnService({
    runtimeFactory: () => fakeRuntime,
    existsFn: async () => true,
  });

  const snapshot = await service.getSnapshot(
    {
      vpn: {
        appExecutable: fakeRuntime.appExecutable,
      },
    },
    { includeOfficialUi: false },
  );

  assert.deepEqual(snapshot.status.latestCachedToken, {
    token: undefined,
    tokenRedacted: "cached...oken",
    loginStatus: { status: "1" },
  });
  assert.deepEqual(snapshot.environmentInfo.latestCachedToken, {
    token: undefined,
    tokenRedacted: "cached...oken",
    loginStatus: { status: "1" },
  });
});

test("VpnService.getSnapshot keeps online status when local runtime info is temporarily unavailable", async () => {
  const fakeRuntime = {
    async describeActiveSession() {
      return {
        token: "secret-token",
        sessionId: "session-1",
      };
    },
    async getLoginStatus() {
      return { status: "1" };
    },
    async getServiceState() {
      return { base: "18", l3vpn: "18", tcp: "43" };
    },
    async getLocalRuntimeInfo() {
      throw new Error("Failed to get local runtime info: empty response");
    },
    async getBundleSettingPath() {
      return "/Applications/EasyConnect.app/Contents/Resources/conf/setting_demo.json";
    },
    async getPort() {
      return 54530;
    },
    async describeLatestCachedToken() {
      return {};
    },
    async getGatewayCandidates() {
      return [];
    },
    appExecutable: "/Applications/EasyConnect.app/Contents/MacOS/EasyConnect",
  };

  const service = new VpnService({
    runtimeFactory: () => fakeRuntime,
    existsFn: async () => true,
  });

  const snapshot = await service.getSnapshot(
    {
      vpn: {
        appExecutable: fakeRuntime.appExecutable,
      },
    },
    { includeOfficialUi: false },
  );

  assert.deepEqual(snapshot.status.loginStatus, { status: "1" });
  assert.deepEqual(snapshot.status.serviceState, { base: "18", l3vpn: "18", tcp: "43" });
  assert.match(snapshot.status.localRuntimeInfo.error, /local runtime info/i);
});

test("VpnService.getSnapshot includes official UI target state without raw page text", async () => {
  const fakeRuntime = {
    async describeActiveSession() {
      return {
        token: "secret-token",
        sessionId: "session-1",
      };
    },
    async getLoginStatus() {
      return { status: "1" };
    },
    async getServiceState() {
      return { base: "18" };
    },
    async getLocalRuntimeInfo() {
      return { enableAutoLogin: 0 };
    },
    async getOfficialNativeWindowState() {
      return { ok: true, visible: true, windowCount: 2, windowNames: ["EasyConnect", "EasyConnect"] };
    },
    async getRemoteDebugTargets() {
      return [
        {
          id: "connect-target",
          type: "page",
          title: "EasyConnect",
          url: "file:///Applications/EasyConnect.app/Contents/Resources/Web/local/connect/connect.html",
          webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/connect-target",
        },
      ];
    },
    async evaluateOnRemoteDebugPageTarget(target) {
      return {
        target,
        evaluation: {
          result: {
            value: {
              href: "file:///Applications/EasyConnect.app/Contents/Resources/Web/local/connect/connect.html",
              title: "EasyConnect",
              visibilityState: "visible",
              hidden: false,
              bodyText: "无法连接 账号 demo-user",
            },
          },
        },
      };
    },
    async getBundleSettingPath() {
      return "/Applications/EasyConnect.app/Contents/Resources/conf/setting_demo.json";
    },
    async getPort() {
      return 54530;
    },
    async describeLatestCachedToken() {
      return {};
    },
    async getGatewayCandidates() {
      return [];
    },
    appExecutable: "/Applications/EasyConnect.app/Contents/MacOS/EasyConnect",
  };

  const service = new VpnService({
    runtimeFactory: () => fakeRuntime,
    existsFn: async () => true,
  });

  const snapshot = await service.getSnapshot({
    vpn: {
      remoteDebugPort: 9222,
      appExecutable: fakeRuntime.appExecutable,
    },
  });

  assert.equal(snapshot.status.officialUi.primaryTarget.kind, "probe-failed");
  assert.equal(snapshot.status.officialUi.hasBlockingVisibleTarget, true);
  assert.equal(JSON.stringify(snapshot.status.officialUi).includes("账号 demo-user"), false);
});

test("VpnService.repairOfficialUi reports incomplete when hidden service restore remains blocked", async () => {
  const calls = [];
  const delays = [];
  const fakeRuntime = {
    async describeActiveSession() {
      calls.push("describeActiveSession");
      return {
        token: "secret-token",
        sessionId: "session-1",
      };
    },
    async getLoginStatus() {
      calls.push("getLoginStatus");
      return { status: "1" };
    },
    async getServiceState() {
      calls.push("getServiceState");
      return { base: "18", l3vpn: "18", tcp: "43" };
    },
    async getLocalRuntimeInfo() {
      calls.push("getLocalRuntimeInfo");
      return { enableAutoLogin: 0 };
    },
    async getRemoteDebugTargets() {
      calls.push("getRemoteDebugTargets");
      return [
        {
          id: "connect-target",
          type: "page",
          title: "EasyConnect",
          url: "file:///Applications/EasyConnect.app/Contents/Resources/Web/local/connect/connect.html",
          webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/connect-target",
        },
        {
          id: "service-target",
          type: "page",
          title: "EasyConnect",
          url: "https://198.51.100.20:9898/portal/#!/service",
          webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/service-target",
        },
      ];
    },
    async evaluateOnRemoteDebugPageTarget(target) {
      if (target.id === "connect-target") {
        return {
          evaluation: {
            result: {
              value: {
                href: "file:///Applications/EasyConnect.app/Contents/Resources/Web/local/connect/connect.html",
                title: "EasyConnect",
                visibilityState: "visible",
                hidden: false,
                bodyText: "无法连接",
              },
            },
          },
        };
      }

      return {
        evaluation: {
          result: {
            value: {
              href: "https://198.51.100.20:9898/portal/#!/service",
              title: "EasyConnect",
              visibilityState: "hidden",
              hidden: true,
              bodyText: "资源搜索 默认资源组",
            },
          },
        },
      };
    },
    async getBundleSettingPath() {
      return "/Applications/EasyConnect.app/Contents/Resources/conf/setting_demo.json";
    },
    async getPort() {
      return 54530;
    },
    async describeLatestCachedToken() {
      return {};
    },
    async getGatewayCandidates() {
      return [];
    },
    async navigatePortalRoute(targetUrlPart, targetUrl, options) {
      calls.push(["navigatePortalRoute", targetUrlPart, targetUrl, options.remoteDebugPort]);
      return { ok: true, href: targetUrl };
    },
    async waitForRemoteDebugTarget(targetUrlPart, options) {
      calls.push(["waitForRemoteDebugTarget", targetUrlPart, options.remoteDebugPort]);
      return { id: "service-target", url: "https://198.51.100.20:9898/portal/#!/service" };
    },
    async syncPortalGlobalState(targetUrlPart, context, options) {
      calls.push(["syncPortalGlobalState", targetUrlPart, context.sessionId, context.gatewayHost, context.gatewayPort, options.profile]);
      return { ok: true };
    },
    async bootstrapViaPageBridge(targetUrlPart, context, options) {
      calls.push(["bootstrapViaPageBridge", targetUrlPart, context.sessionId, options.remoteDebugPort]);
      return { ok: true, token: "derived-token" };
    },
    async reloadPortalTarget(targetUrlPart, options) {
      calls.push(["reloadPortalTarget", targetUrlPart, options.remoteDebugPort]);
      return { ok: true, href: "https://198.51.100.20:9898/portal/#!/service" };
    },
    async navigateRemoteDebugTarget(targetUrlPart, targetUrl, options) {
      calls.push(["navigateRemoteDebugTarget", targetUrlPart, targetUrl, options.remoteDebugPort]);
      return { ok: true, requestedUrl: targetUrl };
    },
    appExecutable: "/Applications/EasyConnect.app/Contents/MacOS/EasyConnect",
  };

  const service = new VpnService({
    runtimeFactory: () => fakeRuntime,
    ensureOnlineFn: async () => {
      throw new Error("repairOfficialUi should not call ensureOnline");
    },
    gatewayLoginFactory: () => {
      throw new Error("repairOfficialUi should not create gateway login");
    },
    existsFn: async () => true,
    dataPlaneProbeFn: async () => {
      throw new Error("repairOfficialUi must not run a second data-plane probe");
    },
    delayFn: async (ms) => {
      delays.push(ms);
    },
  });

  const config = {
    vpn: {
      username: "demo-user",
      remoteDebugPort: 9222,
      gateways: [{ host: "198.51.100.20", port: 9898 }],
    },
  };
  const result = await service.repairOfficialUi(config, {
    allowLoginFallbackNavigation: false,
    postRepairSettleMs: 10,
  });

  assert.equal(result.action, "restore-hidden-service-target-incomplete");
  assert.deepEqual(delays, [10]);
  assert.equal(result.status.officialUi.hasBlockingVisibleTarget, true);
  assert.equal(result.status.officialUi.hasVisibleServiceTarget, false);
  assert.equal(result.safeFallback?.action, "skip-official-ui-login-fallback-disabled");
  assert.deepEqual(result.restoredFrom, {
    id: "connect-target",
    kind: "probe-failed",
    title: "EasyConnect",
    url: "file:///Applications/EasyConnect.app/Contents/Resources/Web/local/connect/connect.html",
    visible: true,
    originalKind: "probe-failed",
  });
});

test("VpnService.repairOfficialUi restores the missing service target from an online user-setting state", async () => {
  const calls = [];
  let targetListCalls = 0;
  const notfoundUrl =
    "file:///Applications/EasyConnect.app/Contents/Resources/Web/local/connect_notfound/connect_notfound.html?from=https%3A%2F%2F198.51.100.20%3A9898%2Fportal%2F%23!%2Fservice";
  const fakeRuntime = {
    async describeActiveSession() {
      return {
        token: "secret-token",
        sessionId: "session-1",
      };
    },
    async getLoginStatus() {
      return { status: "1" };
    },
    async getServiceState() {
      return { base: "18", l3vpn: "18", tcp: "43" };
    },
    async getLocalRuntimeInfo() {
      return { enableAutoLogin: 0 };
    },
    async getRemoteDebugTargets() {
      targetListCalls += 1;
      if (targetListCalls > 1) {
        return [
          {
            id: "service-target",
            type: "page",
            title: "EasyConnect",
            url: "https://198.51.100.20:9898/portal/#!/service",
            webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/service-target",
          },
        ];
      }

      return [
        {
          id: "notfound-target",
          type: "page",
          title: "EasyConnect",
          url: notfoundUrl,
          webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/notfound-target",
        },
        {
          id: "user-setting-target",
          type: "page",
          title: "个人设置",
          url: "https://198.51.100.20:9898/portal/#!/user_setting_box",
          webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/user-setting-target",
        },
        {
          id: "status-target",
          type: "page",
          title: "EasyConnect",
          url: "file:///Applications/EasyConnect.app/Contents/Resources/Web/local/vpn_status_manager/vpn_status_manager.html",
          webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/status-target",
        },
        {
          id: "connect-target",
          type: "page",
          title: "EasyConnect",
          url: "file:///Applications/EasyConnect.app/Contents/Resources/Web/local/connect/connect.html",
          webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/connect-target",
        },
      ];
    },
    async evaluateOnRemoteDebugPageTarget(target) {
      const visible = target.id === "user-setting-target" || target.id === "status-target";
      return {
        evaluation: {
          result: {
            value: {
              href: target.url,
              title: target.title,
              visibilityState: visible ? "visible" : "hidden",
              hidden: !visible,
              bodyText: target.id === "user-setting-target" ? "个人设置 修改密码 登录设备" : "",
            },
          },
        },
      };
    },
    async getBundleSettingPath() {
      return "/Applications/EasyConnect.app/Contents/Resources/conf/setting_demo.json";
    },
    async getPort() {
      return 54530;
    },
    async describeLatestCachedToken() {
      return {};
    },
    async getGatewayCandidates() {
      return [];
    },
    async waitForRemoteDebugTarget(targetUrlPart, options) {
      calls.push(["waitForRemoteDebugTarget", targetUrlPart, options.remoteDebugPort]);
      return { id: "service-target", url: "https://198.51.100.20:9898/portal/#!/service" };
    },
    async syncPortalGlobalState(targetUrlPart, context, options) {
      calls.push(["syncPortalGlobalState", targetUrlPart, context.sessionId, context.gatewayHost, context.gatewayPort, options.profile]);
      return { ok: true };
    },
    async bootstrapViaPageBridge(targetUrlPart, context, options) {
      calls.push(["bootstrapViaPageBridge", targetUrlPart, context.sessionId, options.remoteDebugPort]);
      return { ok: true, token: "derived-token" };
    },
    async reloadPortalTarget(targetUrlPart, options) {
      calls.push(["reloadPortalTarget", targetUrlPart, options.remoteDebugPort]);
      return { ok: true, href: "https://198.51.100.20:9898/portal/#!/service" };
    },
    async navigateRemoteDebugTarget(targetUrlPart, targetUrl, options) {
      calls.push(["navigateRemoteDebugTarget", targetUrlPart, targetUrl, options.remoteDebugPort]);
      return { ok: true, requestedUrl: targetUrl };
    },
    appExecutable: "/Applications/EasyConnect.app/Contents/MacOS/EasyConnect",
  };

  const service = new VpnService({
    runtimeFactory: () => fakeRuntime,
    existsFn: async () => true,
  });

  const config = {
    vpn: {
      username: "demo-user",
      remoteDebugPort: 9222,
      gateways: [{ host: "198.51.100.20", port: 9898 }],
    },
  };
  const result = await service.repairOfficialUi(config);

  assert.equal(result.action, "restore-missing-service-target");
  assert.deepEqual(
    calls.filter((call) => Array.isArray(call) && call[0] === "navigateRemoteDebugTarget"),
    [
      [
        "navigateRemoteDebugTarget",
        "notfound-target",
        "https://198.51.100.20:9898/portal/#!/service",
        9222,
      ],
    ],
  );
  assert.deepEqual(calls.filter((call) => Array.isArray(call)).map((call) => call[0]), [
    "navigateRemoteDebugTarget",
    "waitForRemoteDebugTarget",
    "syncPortalGlobalState",
    "bootstrapViaPageBridge",
    "reloadPortalTarget",
    "waitForRemoteDebugTarget",
    "waitForRemoteDebugTarget",
  ]);
});

test("VpnService.repairOfficialUi reports incomplete restore when final official UI is still connect_notfound", async () => {
  const calls = [];
  const notfoundUrl =
    "file:///Applications/EasyConnect.app/Contents/Resources/Web/local/connect_notfound/connect_notfound.html?from=https%3A%2F%2F198.51.100.20%3A9898%2Fportal%2F%23!%2Fservice";
  const fakeRuntime = {
    async describeActiveSession() {
      return {
        token: "secret-token",
        sessionId: "session-1",
      };
    },
    async getLoginStatus() {
      return { status: "1" };
    },
    async getServiceState() {
      return { base: "18", l3vpn: "18", tcp: "43" };
    },
    async getLocalRuntimeInfo() {
      return { enableAutoLogin: 0 };
    },
    async getRemoteDebugTargets() {
      calls.push("getRemoteDebugTargets");
      return [
        {
          id: "notfound-target",
          type: "page",
          title: "EasyConnect",
          url: notfoundUrl,
          webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/notfound-target",
        },
      ];
    },
    async evaluateOnRemoteDebugPageTarget(target) {
      return {
        evaluation: {
          result: {
            value: {
              href: target.url,
              title: target.title,
              visibilityState: "hidden",
              hidden: true,
              bodyText: "连接失败 请尝试刷新后重试",
            },
          },
        },
      };
    },
    async getBundleSettingPath() {
      return "/Applications/EasyConnect.app/Contents/Resources/conf/setting_demo.json";
    },
    async getPort() {
      return 54530;
    },
    async describeLatestCachedToken() {
      return {};
    },
    async getGatewayCandidates() {
      return [];
    },
    async waitForRemoteDebugTarget(targetUrlPart, options) {
      calls.push(["waitForRemoteDebugTarget", targetUrlPart, options.remoteDebugPort]);
      return { id: "service-target", url: "https://198.51.100.20:9898/portal/#!/service" };
    },
    async syncPortalGlobalState(targetUrlPart, context, options) {
      calls.push(["syncPortalGlobalState", targetUrlPart, context.sessionId, options.profile]);
      return { ok: true };
    },
    async bootstrapViaPageBridge(targetUrlPart, context, options) {
      calls.push(["bootstrapViaPageBridge", targetUrlPart, context.sessionId, options.remoteDebugPort]);
      return { ok: false, reason: "SF bridge missing" };
    },
    async reloadPortalTarget(targetUrlPart, options) {
      calls.push(["reloadPortalTarget", targetUrlPart, options.remoteDebugPort]);
      return { ok: true, href: "https://198.51.100.20:9898/portal/#!/service" };
    },
    async navigateRemoteDebugTarget(targetUrlPart, targetUrl, options) {
      calls.push(["navigateRemoteDebugTarget", targetUrlPart, targetUrl, options.remoteDebugPort]);
      return { ok: true, requestedUrl: targetUrl };
    },
    appExecutable: "/Applications/EasyConnect.app/Contents/MacOS/EasyConnect",
  };

  const service = new VpnService({
    runtimeFactory: () => fakeRuntime,
    existsFn: async () => true,
  });

  const result = await service.repairOfficialUi({
    vpn: {
      username: "demo-user",
      remoteDebugPort: 9222,
      gateways: [{ host: "198.51.100.20", port: 9898 }],
    },
  });

  assert.equal(result.action, "restore-missing-service-target-incomplete");
  assert.equal(result.status.officialUi.hasServiceTarget, false);
  assert.equal(result.status.officialUi.primaryTarget.kind, "probe-failed");
  assert.equal(calls.filter((call) => call === "getRemoteDebugTargets").length >= 2, true);
});

test("VpnService.repairOfficialUi moves unrecoverable online UI back to login", async () => {
  const calls = [];
  const serviceTarget = {
    id: "service-target",
    type: "page",
    title: "Loading...",
    url: "https://198.51.100.20:9898/portal/#!/service",
    webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/service-target",
  };
  const fakeRuntime = {
    async describeActiveSession() {
      return {
        token: "secret-token",
        sessionId: "session-1",
      };
    },
    async getLoginStatus() {
      return { status: "1" };
    },
    async getServiceState() {
      return { base: "18", l3vpn: "18", tcp: "43" };
    },
    async getLocalRuntimeInfo() {
      return { enableAutoLogin: 0 };
    },
    async getRemoteDebugTargets() {
      return [serviceTarget];
    },
    async evaluateOnRemoteDebugPageTarget(target) {
      return {
        evaluation: {
          result: {
            value: {
              href: target.url,
              title: target.title,
              visibilityState: "visible",
              hidden: false,
              bodyText: "加载失败 获取资源配置文件失败 请尝试刷新后重试",
            },
          },
        },
      };
    },
    async getBundleSettingPath() {
      return "/Applications/EasyConnect.app/Contents/Resources/conf/setting_demo.json";
    },
    async getPort() {
      return 54530;
    },
    async describeLatestCachedToken() {
      return {};
    },
    async getGatewayCandidates() {
      return [];
    },
    async navigateRemoteDebugTarget(targetUrlPart, targetUrl, options) {
      calls.push(["navigateRemoteDebugTarget", targetUrlPart, targetUrl, options.remoteDebugPort]);
      return { ok: true, requestedUrl: targetUrl };
    },
    async waitForRemoteDebugTarget(targetUrlPart, options) {
      calls.push(["waitForRemoteDebugTarget", targetUrlPart, options.remoteDebugPort]);
      return serviceTarget;
    },
    async syncPortalGlobalState() {
      throw new Error("Timed out waiting for WebSocket message");
    },
    appExecutable: "/Applications/EasyConnect.app/Contents/MacOS/EasyConnect",
  };

  const service = new VpnService({
    runtimeFactory: () => fakeRuntime,
    existsFn: async () => true,
  });

  const result = await service.repairOfficialUi({
    vpn: {
      username: "demo-user",
      remoteDebugPort: 9222,
      gateways: [{ host: "198.51.100.20", port: 9898 }],
    },
  });

  assert.equal(result.action, "repair-official-ui-incomplete");
  assert.equal(result.safeFallback?.action, "navigate-official-ui-login");
  assert.deepEqual(calls.filter((call) => call[0] === "navigateRemoteDebugTarget"), [
    [
      "navigateRemoteDebugTarget",
      "service-target",
      "https://198.51.100.20:9898/portal/#!/login",
      9222,
    ],
  ]);
});

test("VpnService.repairOfficialUi does not create login fallback targets in background while native windows are unstable", async () => {
  const calls = [];
  const serviceTarget = {
    id: "service-target",
    type: "page",
    title: "Loading...",
    url: "https://198.51.100.20:9898/portal/#!/service",
    webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/service-target",
  };
  const loginTarget = {
    id: "login-target",
    type: "page",
    title: "EasyConnect",
    url: "https://198.51.100.20:9898/portal/#!/login",
    webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/login-target",
  };
  const fakeRuntime = {
    async describeActiveSession() {
      return {
        token: "secret-token",
        sessionId: "session-1",
      };
    },
    async getLoginStatus() {
      return { status: "1" };
    },
    async getServiceState() {
      return { base: "18", l3vpn: "18", tcp: "43" };
    },
    async getLocalRuntimeInfo() {
      return { enableAutoLogin: 0 };
    },
    async getRemoteDebugTargets() {
      return [serviceTarget, loginTarget];
    },
    async evaluateOnRemoteDebugPageTarget(target) {
      const isLogin = target.url.includes("/portal/#!/login");
      return {
        evaluation: {
          result: {
            value: {
              href: target.url,
              title: target.title,
              visibilityState: "visible",
              hidden: false,
              bodyText: isLogin ? "用户名 密码 登录" : "加载中",
            },
          },
        },
      };
    },
    async getOfficialNativeWindowState() {
      return {
        ok: true,
        visible: true,
        windowCount: 2,
        windowNames: ["EasyConnect", "EasyConnect"],
        alerts: [
          {
            text: "ecResize response data error, errorcode:0, errormsg:onResizeWindow failed, winID is not exist",
            buttons: ["OK"],
          },
        ],
      };
    },
    async getBundleSettingPath() {
      return "/Applications/EasyConnect.app/Contents/Resources/conf/setting_demo.json";
    },
    async getPort() {
      return 54530;
    },
    async describeLatestCachedToken() {
      return {};
    },
    async getGatewayCandidates() {
      return [];
    },
    async waitForRemoteDebugTarget(targetUrlPart, options) {
      calls.push(["waitForRemoteDebugTarget", targetUrlPart, options.remoteDebugPort]);
      return serviceTarget;
    },
    async syncPortalGlobalState(targetUrlPart, context, options) {
      calls.push(["syncPortalGlobalState", targetUrlPart, context.sessionId, options.profile]);
      return { ok: true };
    },
    async bootstrapViaPageBridge(targetUrlPart, context, options) {
      calls.push(["bootstrapViaPageBridge", targetUrlPart, context.sessionId, options.remoteDebugPort]);
      return { ok: false, reason: "SF bridge missing" };
    },
    async reloadPortalTarget(targetUrlPart, options) {
      calls.push(["reloadPortalTarget", targetUrlPart, options.remoteDebugPort]);
      return { ok: true, href: "https://198.51.100.20:9898/portal/#!/service" };
    },
    async navigateRemoteDebugTarget(targetUrlPart, targetUrl, options) {
      calls.push(["navigateRemoteDebugTarget", targetUrlPart, targetUrl, options.remoteDebugPort]);
      return { ok: true, requestedUrl: targetUrl };
    },
    async closeOfficialWindowTarget(targetUrlPart, options) {
      calls.push(["closeOfficialWindowTarget", targetUrlPart, options.remoteDebugPort]);
      return { ok: true };
    },
    appExecutable: "/Applications/EasyConnect.app/Contents/MacOS/EasyConnect",
  };

  const service = new VpnService({
    runtimeFactory: () => fakeRuntime,
    existsFn: async () => true,
  });

  const result = await service.repairOfficialUi(
    {
      vpn: {
        username: "demo-user",
        remoteDebugPort: 9222,
        gateways: [{ host: "198.51.100.20", port: 9898 }],
      },
    },
    { allowNativeWindowActivation: false },
  );

  assert.equal(result.action, "skip-native-window-activation-background");
  assert.equal(result.nativeWindowActivation?.hasBlockingNativeAlert, true);
  assert.equal(result.nativeWindowActivation?.hasDuplicateNativeWindows, true);
  assert.deepEqual(calls.filter((call) => Array.isArray(call) && call[0] === "navigateRemoteDebugTarget"), []);
  assert.deepEqual(calls.filter((call) => Array.isArray(call) && call[0] === "closeOfficialWindowTarget"), []);
});

test("VpnService.repairOfficialUi keeps background login safe state instead of navigating service", async () => {
  const calls = [];
  let targetListCalls = 0;
  const loginTarget = {
    id: "official-target",
    type: "page",
    title: "Loading...",
    url: "https://198.51.100.20:9898/portal/#!/login",
    webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/official-target",
  };
  const serviceTarget = {
    ...loginTarget,
    url: "https://198.51.100.20:9898/portal/#!/service",
  };
  const fakeRuntime = {
    async describeActiveSession() {
      return {
        token: "secret-token",
        sessionId: "session-1",
      };
    },
    async getLoginStatus() {
      return { status: "1" };
    },
    async getServiceState() {
      return { base: "18", l3vpn: "18", tcp: "43" };
    },
    async getLocalRuntimeInfo() {
      return { enableAutoLogin: 0 };
    },
    async getRemoteDebugTargets() {
      targetListCalls += 1;
      return targetListCalls === 1 ? [loginTarget] : [serviceTarget];
    },
    async evaluateOnRemoteDebugPageTarget(target) {
      const isLogin = target.url.includes("/portal/#!/login");
      return {
        evaluation: {
          result: {
            value: {
              href: target.url,
              title: target.title,
              visibilityState: isLogin ? "hidden" : "visible",
              hidden: isLogin,
              bodyText: isLogin ? "用户名 密码 登录" : "加载中",
            },
          },
        },
      };
    },
    async getOfficialNativeWindowState() {
      return {
        ok: true,
        visible: true,
        windowCount: 0,
        windowNames: [],
        alerts: [],
      };
    },
    async getBundleSettingPath() {
      return "/Applications/EasyConnect.app/Contents/Resources/conf/setting_demo.json";
    },
    async getPort() {
      return 54530;
    },
    async describeLatestCachedToken() {
      return {};
    },
    async getGatewayCandidates() {
      return [];
    },
    async waitForRemoteDebugTarget(targetUrlPart, options) {
      calls.push(["waitForRemoteDebugTarget", targetUrlPart, options.remoteDebugPort]);
      return serviceTarget;
    },
    async syncPortalGlobalState(targetUrlPart, context, options) {
      calls.push(["syncPortalGlobalState", targetUrlPart, context.sessionId, options.profile]);
      throw new Error("Timed out waiting for WebSocket message");
    },
    async bootstrapViaPageBridge(targetUrlPart, context, options) {
      calls.push(["bootstrapViaPageBridge", targetUrlPart, context.sessionId, options.remoteDebugPort]);
      return { ok: false, reason: "SF bridge missing" };
    },
    async reloadPortalTarget(targetUrlPart, options) {
      calls.push(["reloadPortalTarget", targetUrlPart, options.remoteDebugPort]);
      return { ok: true, href: serviceTarget.url };
    },
    async navigateRemoteDebugTarget(targetUrlPart, targetUrl, options) {
      calls.push(["navigateRemoteDebugTarget", targetUrlPart, targetUrl, options.remoteDebugPort]);
      return { ok: true, requestedUrl: targetUrl };
    },
    appExecutable: "/Applications/EasyConnect.app/Contents/MacOS/EasyConnect",
  };

  const service = new VpnService({
    runtimeFactory: () => fakeRuntime,
    existsFn: async () => true,
  });

  const result = await service.repairOfficialUi(
    {
      vpn: {
        username: "demo-user",
        remoteDebugPort: 9222,
        gateways: [{ host: "198.51.100.20", port: 9898 }],
      },
    },
    { allowNativeWindowActivation: false },
  );

  assert.equal(result.action, "restore-missing-service-target-incomplete");
  assert.equal(result.safeFallback?.action, "already-official-ui-login");
  assert.equal(result.status.officialUi.primaryTarget.kind, "login");
  assert.deepEqual(calls.filter((call) => Array.isArray(call)), []);
});

test("VpnService.repairOfficialUi does not periodically navigate hidden service targets to login in background", async () => {
  const calls = [];
  const serviceTarget = {
    id: "service-target",
    type: "page",
    title: "EasyConnect",
    url: "https://198.51.100.20:9898/portal/#!/service",
    webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/service-target",
  };
  const connectTarget = {
    id: "connect-target",
    type: "page",
    title: "EasyConnect",
    url: "file:///Applications/EasyConnect.app/Contents/Resources/Web/local/connect/connect.html",
    webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/connect-target",
  };
  const statusTarget = {
    id: "status-target",
    type: "page",
    title: "EasyConnect",
    url: "file:///Applications/EasyConnect.app/Contents/Resources/Web/local/vpn_status_manager/vpn_status_manager.html",
    webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/status-target",
  };
  const fakeRuntime = {
    async describeActiveSession() {
      return {
        token: "secret-token",
        sessionId: "session-1",
      };
    },
    async getLoginStatus() {
      return { status: "1" };
    },
    async getServiceState() {
      return { base: "18", l3vpn: "18", tcp: "43" };
    },
    async getLocalRuntimeInfo() {
      return { enableAutoLogin: 0 };
    },
    async getRemoteDebugTargets() {
      return [serviceTarget, connectTarget, statusTarget];
    },
    async evaluateOnRemoteDebugPageTarget(target) {
      const isService = target.id === "service-target";
      return {
        evaluation: {
          result: {
            value: {
              href: target.url,
              title: target.title,
              visibilityState: isService ? "hidden" : "visible",
              hidden: isService,
              bodyText: isService ? "默认资源组 资源搜索" : "",
            },
          },
        },
      };
    },
    async getOfficialNativeWindowState() {
      return {
        ok: true,
        visible: true,
        windowCount: 1,
        windowNames: ["EasyConnect"],
        alerts: [],
      };
    },
    async getBundleSettingPath() {
      return "/Applications/EasyConnect.app/Contents/Resources/conf/setting_demo.json";
    },
    async getPort() {
      return 54530;
    },
    async describeLatestCachedToken() {
      return {};
    },
    async getGatewayCandidates() {
      return [];
    },
    async navigateRemoteDebugTarget(targetUrlPart, targetUrl, options) {
      calls.push(["navigateRemoteDebugTarget", targetUrlPart, targetUrl, options.remoteDebugPort]);
      return { ok: true, requestedUrl: targetUrl };
    },
    appExecutable: "/Applications/EasyConnect.app/Contents/MacOS/EasyConnect",
  };

  const service = new VpnService({
    runtimeFactory: () => fakeRuntime,
    existsFn: async () => true,
  });

  const result = await service.repairOfficialUi(
    {
      vpn: {
        username: "demo-user",
        remoteDebugPort: 9222,
        gateways: [{ host: "198.51.100.20", port: 9898 }],
      },
    },
    { allowNativeWindowActivation: false },
  );

  assert.equal(result.action, "restore-hidden-service-target-incomplete");
  assert.equal(result.safeFallback?.action, "skip-official-ui-login-fallback-background");
  assert.equal(result.status.officialUi.hasServiceTarget, true);
  assert.equal(result.status.officialUi.hasVisibleServiceTarget, false);
  assert.equal(result.status.officialUi.primaryTarget.kind, "connect");
  assert.deepEqual(calls.filter((call) => Array.isArray(call)), []);
});

test("VpnService.repairOfficialUi does not navigate a Loading login target to service in background while ecResize is blocking", async () => {
  const calls = [];
  const loginTarget = {
    id: "official-target",
    type: "page",
    title: "Loading...",
    url: "https://198.51.100.20:9898/portal/#!/login",
    webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/official-target",
  };
  const fakeRuntime = {
    async describeActiveSession() {
      return {
        token: "secret-token",
        sessionId: "session-1",
      };
    },
    async getLoginStatus() {
      return { status: "1" };
    },
    async getServiceState() {
      return { base: "18", l3vpn: "18", tcp: "43" };
    },
    async getLocalRuntimeInfo() {
      return { enableAutoLogin: 0 };
    },
    async getRemoteDebugTargets() {
      return [loginTarget];
    },
    async evaluateOnRemoteDebugPageTarget(target) {
      return {
        evaluation: {
          result: {
            value: {
              href: target.url,
              title: target.title,
              visibilityState: "hidden",
              hidden: true,
              bodyText: "用户名 密码 登录",
            },
          },
        },
      };
    },
    async getOfficialNativeWindowState() {
      return {
        ok: true,
        visible: true,
        windowCount: 1,
        windowNames: ["Loading..."],
        alerts: [
          {
            text: "ecResize response data error, errorcode:0, errormsg:onResizeWindow failed, winID is not exist",
            buttons: ["OK"],
          },
        ],
      };
    },
    async getBundleSettingPath() {
      return "/Applications/EasyConnect.app/Contents/Resources/conf/setting_demo.json";
    },
    async getPort() {
      return 54530;
    },
    async describeLatestCachedToken() {
      return {};
    },
    async getGatewayCandidates() {
      return [];
    },
    async waitForRemoteDebugTarget(targetUrlPart, options) {
      calls.push(["waitForRemoteDebugTarget", targetUrlPart, options.remoteDebugPort]);
      return { ...loginTarget, url: "https://198.51.100.20:9898/portal/#!/service" };
    },
    async syncPortalGlobalState(targetUrlPart, context, options) {
      calls.push(["syncPortalGlobalState", targetUrlPart, context.sessionId, options.profile]);
      return { ok: true };
    },
    async bootstrapViaPageBridge(targetUrlPart, context, options) {
      calls.push(["bootstrapViaPageBridge", targetUrlPart, context.sessionId, options.remoteDebugPort]);
      return { ok: false, reason: "SF bridge missing" };
    },
    async reloadPortalTarget(targetUrlPart, options) {
      calls.push(["reloadPortalTarget", targetUrlPart, options.remoteDebugPort]);
      return { ok: true, href: "https://198.51.100.20:9898/portal/#!/service" };
    },
    async navigateRemoteDebugTarget(targetUrlPart, targetUrl, options) {
      calls.push(["navigateRemoteDebugTarget", targetUrlPart, targetUrl, options.remoteDebugPort]);
      return { ok: true, requestedUrl: targetUrl };
    },
    appExecutable: "/Applications/EasyConnect.app/Contents/MacOS/EasyConnect",
  };

  const service = new VpnService({
    runtimeFactory: () => fakeRuntime,
    existsFn: async () => true,
  });

  const result = await service.repairOfficialUi(
    {
      vpn: {
        username: "demo-user",
        remoteDebugPort: 9222,
        gateways: [{ host: "198.51.100.20", port: 9898 }],
      },
    },
    { allowNativeWindowActivation: false },
  );

  assert.equal(result.action, "restore-missing-service-target-incomplete");
  assert.equal(result.safeFallback?.action, "skip-official-ui-login-fallback-background-native-window");
  assert.equal(result.status.officialUi.hasBlockingNativeAlert, true);
  assert.deepEqual(calls.filter((call) => Array.isArray(call)), []);
});

test("VpnService.repairOfficialUi cleans a visible connect_notfound error in background when it is already on screen", async () => {
  const calls = [];
  let notfoundClosed = false;
  let nativeWindowCount = 2;
  let nativeAlerts = [
    {
      text: "ecResize response data error, errorcode:0, errormsg:onResizeWindow failed, winID is not exist",
      buttons: ["OK"],
    },
    {
      text: "ecResize response data error, errorcode:0, errormsg:onResizeWindow failed, winID is not exist",
      buttons: ["OK"],
    },
  ];
  const serviceTarget = {
    id: "service-target",
    type: "page",
    title: "EasyConnect",
    url: "https://198.51.100.20:9898/portal/#!/service",
    webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/service-target",
  };
  const notfoundTarget = {
    id: "notfound-target",
    type: "page",
    title: "EasyConnect",
    url: "file:///Applications/EasyConnect.app/Contents/Resources/Web/local/connect_notfound/connect_notfound.html?from=https%3A%2F%2F198.51.100.20%3A9898%2Fportal%2F%23!%2Fservice",
    webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/notfound-target",
  };
  const fakeRuntime = {
    async describeActiveSession() {
      return {
        token: "secret-token",
        sessionId: "session-1",
      };
    },
    async getLoginStatus() {
      return { status: "1" };
    },
    async getServiceState() {
      return { base: "18", l3vpn: "18", tcp: "43" };
    },
    async getLocalRuntimeInfo() {
      return { enableAutoLogin: 0 };
    },
    async getRemoteDebugTargets() {
      return notfoundClosed ? [serviceTarget] : [serviceTarget, notfoundTarget];
    },
    async evaluateOnRemoteDebugPageTarget(target) {
      const isNotfound = target.id === "notfound-target";
      return {
        evaluation: {
          result: {
            value: {
              href: target.url,
              title: target.title,
              visibilityState: isNotfound && !notfoundClosed ? "visible" : "visible",
              hidden: false,
              bodyText: isNotfound ? "连接失败 刷新后重试" : "资源搜索 默认资源组",
            },
          },
        },
      };
    },
    async getOfficialNativeWindowState() {
      return {
        ok: true,
        visible: true,
        windowCount: nativeWindowCount,
        windowNames: Array.from({ length: nativeWindowCount }, () => "EasyConnect"),
        alerts: nativeAlerts,
      };
    },
    async closeOfficialWindowTarget(targetUrlPart, options) {
      calls.push(["closeOfficialWindowTarget", targetUrlPart, options.remoteDebugPort, options.allowNativeWindowActivation]);
      notfoundClosed = true;
      return { ok: true, closedBy: "official-window-api" };
    },
    async dismissOfficialNativeAlerts(alerts, options) {
      calls.push(["dismissOfficialNativeAlerts", alerts.length, options.remoteDebugPort, options.allowNativeWindowActivation]);
      nativeAlerts = [];
      return { ok: true, dismissed: alerts.length, verified: true };
    },
    async closeExtraOfficialNativeWindows(options) {
      calls.push(["closeExtraOfficialNativeWindows", options.remoteDebugPort, options.allowNativeWindowActivation]);
      nativeWindowCount = 1;
      return { ok: true, beforeCount: 2, afterCount: 1, closed: 1 };
    },
    async getBundleSettingPath() {
      return "/Applications/EasyConnect.app/Contents/Resources/conf/setting_demo.json";
    },
    async getPort() {
      return 54530;
    },
    async describeLatestCachedToken() {
      return {};
    },
    async getGatewayCandidates() {
      return [];
    },
    async waitForRemoteDebugTarget() {
      return serviceTarget;
    },
    async syncPortalGlobalState() {
      return { ok: true };
    },
    async bootstrapViaPageBridge() {
      return { ok: true, token: "derived-token" };
    },
    async reloadPortalTarget() {
      return { ok: true, href: serviceTarget.url };
    },
    async navigateRemoteDebugTarget(targetUrlPart, targetUrl, options) {
      calls.push(["navigateRemoteDebugTarget", targetUrlPart, targetUrl, options.remoteDebugPort]);
      return { ok: true, requestedUrl: targetUrl };
    },
    appExecutable: "/Applications/EasyConnect.app/Contents/MacOS/EasyConnect",
  };

  const service = new VpnService({
    runtimeFactory: () => fakeRuntime,
    existsFn: async () => true,
  });

  const result = await service.repairOfficialUi(
    {
      vpn: {
        username: "demo-user",
        remoteDebugPort: 9222,
        gateways: [{ host: "198.51.100.20", port: 9898 }],
      },
    },
    { allowNativeWindowActivation: false },
  );

  assert.equal(result.action, "repair-official-ui");
  assert.deepEqual(calls.filter((call) => Array.isArray(call) && call[0] === "closeOfficialWindowTarget"), [
    ["closeOfficialWindowTarget", "notfound-target", 9222, true],
  ]);
  assert.deepEqual(calls.filter((call) => Array.isArray(call) && call[0] === "dismissOfficialNativeAlerts"), [
    ["dismissOfficialNativeAlerts", 2, 9222, true],
  ]);
  assert.deepEqual(calls.filter((call) => Array.isArray(call) && call[0] === "closeExtraOfficialNativeWindows"), [
    ["closeExtraOfficialNativeWindows", 9222, true],
  ]);
  assert.deepEqual(calls.filter((call) => Array.isArray(call) && call[0] === "navigateRemoteDebugTarget"), []);
  assert.equal(result.status.officialUi.hasBlockingNativeAlert, false);
  assert.equal(result.status.officialUi.hasDuplicateNativeWindows, false);
  assert.equal(result.status.officialUi.hasBlockingVisibleTarget, false);
});

test("VpnService.repairOfficialUi retries missing service restore before reporting success", async () => {
  const calls = [];
  let targetListCalls = 0;
  const notfoundUrl =
    "file:///Applications/EasyConnect.app/Contents/Resources/Web/local/connect_notfound/connect_notfound.html?from=https%3A%2F%2F198.51.100.20%3A9898%2Fportal%2F%23!%2Fservice";
  const fakeRuntime = {
    async describeActiveSession() {
      return {
        token: "secret-token",
        sessionId: "session-1",
      };
    },
    async getLoginStatus() {
      return { status: "1" };
    },
    async getServiceState() {
      return { base: "18", l3vpn: "18", tcp: "43" };
    },
    async getLocalRuntimeInfo() {
      return { enableAutoLogin: 0 };
    },
    async getRemoteDebugTargets() {
      targetListCalls += 1;
      if (targetListCalls >= 3) {
        return [
          {
            id: "service-target",
            type: "page",
            title: "EasyConnect",
            url: "https://198.51.100.20:9898/portal/#!/service",
            webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/service-target",
          },
        ];
      }

      return [
        {
          id: "notfound-target",
          type: "page",
          title: "EasyConnect",
          url: notfoundUrl,
          webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/notfound-target",
        },
      ];
    },
    async evaluateOnRemoteDebugPageTarget(target) {
      const isService = target.url.includes("/portal/#!/service");
      return {
        evaluation: {
          result: {
            value: {
              href: target.url,
              title: target.title,
              visibilityState: isService ? "visible" : "hidden",
              hidden: !isService,
              bodyText: isService ? "资源搜索 默认资源组" : "连接失败 请尝试刷新后重试",
            },
          },
        },
      };
    },
    async getBundleSettingPath() {
      return "/Applications/EasyConnect.app/Contents/Resources/conf/setting_demo.json";
    },
    async getPort() {
      return 54530;
    },
    async describeLatestCachedToken() {
      return {};
    },
    async getGatewayCandidates() {
      return [];
    },
    async waitForRemoteDebugTarget(targetUrlPart, options) {
      calls.push(["waitForRemoteDebugTarget", targetUrlPart, options.remoteDebugPort]);
      return { id: "service-target", url: "https://198.51.100.20:9898/portal/#!/service" };
    },
    async syncPortalGlobalState(targetUrlPart, context, options) {
      calls.push(["syncPortalGlobalState", targetUrlPart, context.sessionId, options.profile]);
      return { ok: true };
    },
    async bootstrapViaPageBridge(targetUrlPart, context, options) {
      calls.push(["bootstrapViaPageBridge", targetUrlPart, context.sessionId, options.remoteDebugPort]);
      return { ok: false, reason: "SF bridge missing" };
    },
    async reloadPortalTarget(targetUrlPart, options) {
      calls.push(["reloadPortalTarget", targetUrlPart, options.remoteDebugPort]);
      return { ok: true, href: "https://198.51.100.20:9898/portal/#!/service" };
    },
    async navigateRemoteDebugTarget(targetUrlPart, targetUrl, options) {
      calls.push(["navigateRemoteDebugTarget", targetUrlPart, targetUrl, options.remoteDebugPort]);
      return { ok: true, requestedUrl: targetUrl };
    },
    appExecutable: "/Applications/EasyConnect.app/Contents/MacOS/EasyConnect",
  };

  const service = new VpnService({
    runtimeFactory: () => fakeRuntime,
    existsFn: async () => true,
  });

  const result = await service.repairOfficialUi({
    vpn: {
      username: "demo-user",
      remoteDebugPort: 9222,
      gateways: [{ host: "198.51.100.20", port: 9898 }],
    },
  });

  assert.equal(result.action, "restore-missing-service-target");
  assert.equal(result.status.officialUi.hasServiceTarget, true);
  assert.equal(result.retry.reason, "post-repair-official-ui-inconsistent");
  assert.equal(calls.filter((call) => Array.isArray(call) && call[0] === "navigateRemoteDebugTarget").length, 2);
});

test("VpnService.repairOfficialUi treats sync timeout as success when final official UI is service", async () => {
  let targetListCalls = 0;
  const fakeRuntime = {
    async describeActiveSession() {
      return {
        token: "secret-token",
        sessionId: "session-1",
      };
    },
    async getLoginStatus() {
      return { status: "1" };
    },
    async getServiceState() {
      return { base: "18", l3vpn: "18", tcp: "43" };
    },
    async getLocalRuntimeInfo() {
      return { enableAutoLogin: 0 };
    },
    async getRemoteDebugTargets() {
      targetListCalls += 1;
      if (targetListCalls > 1) {
        return [
          {
            id: "service-target",
            type: "page",
            title: "Loading...",
            url: "https://198.51.100.20:9898/portal/#!/service",
            webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/service-target",
          },
        ];
      }

      return [
        {
          id: "login-target",
          type: "page",
          title: "Loading...",
          url: "https://198.51.100.20:9898/portal/#!/login",
          webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/login-target",
        },
      ];
    },
    async evaluateOnRemoteDebugPageTarget(target) {
      const isService = target.url.includes("/portal/#!/service");
      return {
        evaluation: {
          result: {
            value: {
              href: target.url,
              title: target.title,
              visibilityState: isService ? "visible" : "hidden",
              hidden: !isService,
              bodyText: isService ? "资源搜索 默认资源组" : "用户名 密码 登录",
            },
          },
        },
      };
    },
    async getBundleSettingPath() {
      return "/Applications/EasyConnect.app/Contents/Resources/conf/setting_demo.json";
    },
    async getPort() {
      return 54530;
    },
    async describeLatestCachedToken() {
      return {};
    },
    async getGatewayCandidates() {
      return [];
    },
    async waitForRemoteDebugTarget() {
      return { id: "service-target", url: "https://198.51.100.20:9898/portal/#!/service" };
    },
    async syncPortalGlobalState() {
      throw new Error("Timed out waiting for WebSocket message");
    },
    async navigateRemoteDebugTarget() {
      return { ok: true, requestedUrl: "https://198.51.100.20:9898/portal/#!/service" };
    },
    appExecutable: "/Applications/EasyConnect.app/Contents/MacOS/EasyConnect",
  };

  const service = new VpnService({
    runtimeFactory: () => fakeRuntime,
    existsFn: async () => true,
  });

  const result = await service.repairOfficialUi({
    vpn: {
      username: "demo-user",
      remoteDebugPort: 9222,
      gateways: [{ host: "198.51.100.20", port: 9898 }],
    },
  });

  assert.equal(result.action, "restore-missing-service-target");
  assert.equal(result.serviceRefreshError, "Timed out waiting for WebSocket message");
  assert.equal(result.status.officialUi.hasServiceTarget, true);
});

test("VpnService.repairOfficialUi reports incomplete restore when service target reverts after settle", async () => {
  const calls = [];
  const delays = [];
  let targetListCalls = 0;
  const notfoundUrl =
    "file:///Applications/EasyConnect.app/Contents/Resources/Web/local/connect_notfound/connect_notfound.html?from=https%3A%2F%2F198.51.100.20%3A9898%2Fportal%2F%23!%2Fservice";
  const serviceTarget = {
    id: "service-target",
    type: "page",
    title: "EasyConnect",
    url: "https://198.51.100.20:9898/portal/#!/service",
    webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/service-target",
  };
  const notfoundTarget = {
    id: "notfound-target",
    type: "page",
    title: "EasyConnect",
    url: notfoundUrl,
    webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/notfound-target",
  };
  const fakeRuntime = {
    async describeActiveSession() {
      return {
        token: "secret-token",
        sessionId: "session-1",
      };
    },
    async getLoginStatus() {
      return { status: "1" };
    },
    async getServiceState() {
      return { base: "18", l3vpn: "18", tcp: "43" };
    },
    async getLocalRuntimeInfo() {
      return { enableAutoLogin: 0 };
    },
    async getRemoteDebugTargets() {
      targetListCalls += 1;
      if (targetListCalls === 2) {
        return [serviceTarget];
      }

      return [notfoundTarget];
    },
    async evaluateOnRemoteDebugPageTarget(target) {
      const isService = target.url.includes("/portal/#!/service");
      return {
        evaluation: {
          result: {
            value: {
              href: target.url,
              title: target.title,
              visibilityState: isService ? "visible" : "hidden",
              hidden: !isService,
              bodyText: isService ? "资源搜索 默认资源组" : "连接失败 请尝试刷新后重试",
            },
          },
        },
      };
    },
    async getBundleSettingPath() {
      return "/Applications/EasyConnect.app/Contents/Resources/conf/setting_demo.json";
    },
    async getPort() {
      return 54530;
    },
    async describeLatestCachedToken() {
      return {};
    },
    async getGatewayCandidates() {
      return [];
    },
    async waitForRemoteDebugTarget(targetUrlPart, options) {
      calls.push(["waitForRemoteDebugTarget", targetUrlPart, options.remoteDebugPort]);
      return serviceTarget;
    },
    async syncPortalGlobalState(targetUrlPart, context, options) {
      calls.push(["syncPortalGlobalState", targetUrlPart, context.sessionId, options.profile]);
      return { ok: true };
    },
    async bootstrapViaPageBridge(targetUrlPart, context, options) {
      calls.push(["bootstrapViaPageBridge", targetUrlPart, context.sessionId, options.remoteDebugPort]);
      return { ok: false, reason: "SF bridge missing" };
    },
    async reloadPortalTarget(targetUrlPart, options) {
      calls.push(["reloadPortalTarget", targetUrlPart, options.remoteDebugPort]);
      return { ok: true, href: "https://198.51.100.20:9898/portal/#!/service" };
    },
    async navigateRemoteDebugTarget(targetUrlPart, targetUrl, options) {
      calls.push(["navigateRemoteDebugTarget", targetUrlPart, targetUrl, options.remoteDebugPort]);
      return { ok: true, requestedUrl: targetUrl };
    },
    appExecutable: "/Applications/EasyConnect.app/Contents/MacOS/EasyConnect",
  };

  const service = new VpnService({
    runtimeFactory: () => fakeRuntime,
    existsFn: async () => true,
    delayFn: async (ms) => {
      delays.push(ms);
    },
  });

  const result = await service.repairOfficialUi(
    {
      vpn: {
        username: "demo-user",
        remoteDebugPort: 9222,
        gateways: [{ host: "198.51.100.20", port: 9898 }],
      },
    },
    {
      postRepairSettleMs: 12_000,
    },
  );

  assert.equal(result.action, "restore-missing-service-target-incomplete");
  assert.equal(result.status.officialUi.hasServiceTarget, false);
  assert.equal(result.status.officialUi.primaryTarget.kind, "probe-failed");
  assert.deepEqual(delays, [12_000]);
  assert.equal(result.safeFallback?.action, "navigate-official-ui-login");
  assert.deepEqual(calls.filter((call) => Array.isArray(call) && call[0] === "navigateRemoteDebugTarget").map((call) => call[2]), [
    "https://198.51.100.20:9898/portal/#!/service",
    "https://198.51.100.20:9898/portal/#!/service",
    "https://198.51.100.20:9898/portal/#!/login",
  ]);
});

test("VpnService.repairOfficialUi restores the missing service target from an online login state", async () => {
  const calls = [];
  let targetListCalls = 0;
  const fakeRuntime = {
    async describeActiveSession() {
      return {
        token: "secret-token",
        sessionId: "session-1",
      };
    },
    async getLoginStatus() {
      return { status: "1" };
    },
    async getServiceState() {
      return { base: "18", l3vpn: "18", tcp: "43" };
    },
    async getLocalRuntimeInfo() {
      return { enableAutoLogin: 0 };
    },
    async getRemoteDebugTargets() {
      targetListCalls += 1;
      if (targetListCalls > 1) {
        return [
          {
            id: "service-target",
            type: "page",
            title: "EasyConnect",
            url: "https://198.51.100.20:9898/portal/#!/service",
            webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/service-target",
          },
        ];
      }

      return [
        {
          id: "login-target",
          type: "page",
          title: "Loading...",
          url: "https://198.51.100.20:9898/portal/#!/login",
          webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/login-target",
        },
      ];
    },
    async evaluateOnRemoteDebugPageTarget(target) {
      return {
        evaluation: {
          result: {
            value: {
              href: target.url,
              title: target.title,
              visibilityState: null,
              hidden: null,
              bodyText: "用户名 密码 登录",
            },
          },
        },
      };
    },
    async getBundleSettingPath() {
      return "/Applications/EasyConnect.app/Contents/Resources/conf/setting_demo.json";
    },
    async getPort() {
      return 54530;
    },
    async describeLatestCachedToken() {
      return {};
    },
    async getGatewayCandidates() {
      return [];
    },
    async waitForRemoteDebugTarget(targetUrlPart, options) {
      calls.push(["waitForRemoteDebugTarget", targetUrlPart, options.remoteDebugPort]);
      return { id: "service-target", url: "https://198.51.100.20:9898/portal/#!/service" };
    },
    async syncPortalGlobalState(targetUrlPart, context, options) {
      calls.push(["syncPortalGlobalState", targetUrlPart, context.sessionId, context.gatewayHost, context.gatewayPort, options.profile]);
      return { ok: true };
    },
    async bootstrapViaPageBridge(targetUrlPart, context, options) {
      calls.push(["bootstrapViaPageBridge", targetUrlPart, context.sessionId, options.remoteDebugPort]);
      return { ok: true, token: "derived-token" };
    },
    async reloadPortalTarget(targetUrlPart, options) {
      calls.push(["reloadPortalTarget", targetUrlPart, options.remoteDebugPort]);
      return { ok: true, href: "https://198.51.100.20:9898/portal/#!/service" };
    },
    async navigateRemoteDebugTarget(targetUrlPart, targetUrl, options) {
      calls.push(["navigateRemoteDebugTarget", targetUrlPart, targetUrl, options.remoteDebugPort]);
      return { ok: true, requestedUrl: targetUrl };
    },
    appExecutable: "/Applications/EasyConnect.app/Contents/MacOS/EasyConnect",
  };

  const service = new VpnService({
    runtimeFactory: () => fakeRuntime,
    existsFn: async () => true,
  });

  const result = await service.repairOfficialUi({
    vpn: {
      username: "demo-user",
      remoteDebugPort: 9222,
      gateways: [{ host: "198.51.100.20", port: 9898 }],
    },
  });

  assert.equal(result.action, "restore-missing-service-target");
  assert.deepEqual(
    calls.filter((call) => Array.isArray(call) && call[0] === "navigateRemoteDebugTarget"),
    [
      [
        "navigateRemoteDebugTarget",
        "login-target",
        "https://198.51.100.20:9898/portal/#!/service",
        9222,
      ],
    ],
  );
});

test("VpnService.repairOfficialUi relaunches official UI when DevTools is unreachable but tunnel is online", async () => {
  const calls = [];
  let targetListCalls = 0;
  let nativeWindowCalls = 0;
  const newTarget = {
    id: "new-connect-target",
    type: "page",
    title: "EasyConnect",
    url: "file:///Applications/EasyConnect.app/Contents/Resources/Web/local/connect/connect.html",
    webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/new-connect-target",
  };
  const fakeRuntime = {
    async describeActiveSession() {
      return {
        token: "secret-token",
        sessionId: "session-1",
      };
    },
    async getLoginStatus() {
      return { status: "1" };
    },
    async getServiceState() {
      return { base: "18", l3vpn: "18", tcp: "43" };
    },
    async getLocalRuntimeInfo() {
      return { enableAutoLogin: 0 };
    },
    async getRemoteDebugTargets() {
      calls.push("getRemoteDebugTargets");
      targetListCalls += 1;
      if (targetListCalls === 1) {
        throw new Error("Request timed out: GET http://127.0.0.1:9222/json/list");
      }

      return [
        {
          id: "service-target",
          type: "page",
          title: "EasyConnect",
          url: "https://198.51.100.20:9898/portal/#!/service",
          webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/service-target",
        },
      ];
    },
    async evaluateOnRemoteDebugPageTarget(target) {
      return {
        evaluation: {
          result: {
            value: {
              href: target.url,
              title: target.title,
              visibilityState: "visible",
              hidden: false,
              bodyText: "资源搜索 默认资源组",
            },
          },
        },
      };
    },
    async launchMainAppUserMode(options) {
      calls.push(["launchMainAppUserMode", options.remoteDebugPort, options.reuseExisting]);
      return {
        action: "restarted-existing-without-debug",
        remoteDebugPort: options.remoteDebugPort,
      };
    },
    async waitForAnyRemoteDebugPageTarget(options) {
      calls.push(["waitForAnyRemoteDebugPageTarget", options.remoteDebugPort]);
      return newTarget;
    },
    async navigateRemoteDebugPageTarget(target, targetUrl, options) {
      calls.push(["navigateRemoteDebugPageTarget", target.id, targetUrl, options.remoteDebugPort]);
      return { ok: true, requestedUrl: targetUrl };
    },
    async waitForRemoteDebugTarget(targetUrlPart, options) {
      calls.push(["waitForRemoteDebugTarget", targetUrlPart, options.remoteDebugPort]);
      return { id: "service-target", url: "https://198.51.100.20:9898/portal/#!/service" };
    },
    async syncPortalGlobalState(targetUrlPart, context, options) {
      calls.push(["syncPortalGlobalState", targetUrlPart, context.sessionId, options.profile]);
      return { ok: true };
    },
    async bootstrapViaPageBridge(targetUrlPart, context, options) {
      calls.push(["bootstrapViaPageBridge", targetUrlPart, context.sessionId, options.remoteDebugPort]);
      return { ok: true, token: "derived-token" };
    },
    async reloadPortalTarget(targetUrlPart, options) {
      calls.push(["reloadPortalTarget", targetUrlPart, options.remoteDebugPort]);
      return { ok: true, href: "https://198.51.100.20:9898/portal/#!/service" };
    },
    async getOfficialNativeWindowState() {
      calls.push("getOfficialNativeWindowState");
      nativeWindowCalls += 1;
      return nativeWindowCalls === 1
        ? { ok: true, visible: true, windowCount: 0, windowNames: [] }
        : { ok: true, visible: true, windowCount: 1, windowNames: ["EasyConnect"] };
    },
    async showOfficialWindowTarget(targetUrlPart, options) {
      calls.push(["showOfficialWindowTarget", targetUrlPart, options.remoteDebugPort]);
      return { ok: true, method: "SF.windowMgr.show", id: "0" };
    },
    async getBundleSettingPath() {
      return "/Applications/EasyConnect.app/Contents/Resources/conf/setting_demo.json";
    },
    async getPort() {
      return 54530;
    },
    async describeLatestCachedToken() {
      return {};
    },
    async getGatewayCandidates() {
      return [];
    },
    appExecutable: "/Applications/EasyConnect.app/Contents/MacOS/EasyConnect",
  };

  const service = new VpnService({
    runtimeFactory: () => fakeRuntime,
    ensureOnlineFn: async () => {
      throw new Error("repairOfficialUi should not call ensureOnline");
    },
    gatewayLoginFactory: () => {
      throw new Error("repairOfficialUi should not create gateway login");
    },
    existsFn: async () => true,
  });

  const result = await service.repairOfficialUi({
    vpn: {
      username: "demo-user",
      remoteDebugPort: 9222,
      gateways: [{ host: "198.51.100.20", port: 9898 }],
    },
  });

  assert.equal(result.action, "restore-unreachable-official-ui");
  assert.deepEqual(result.relaunch, {
    action: "restarted-existing-without-debug",
    remoteDebugPort: 9222,
  });
  assert.deepEqual(result.restoredFrom, {
    id: "new-connect-target",
    title: "EasyConnect",
    url: "file:///Applications/EasyConnect.app/Contents/Resources/Web/local/connect/connect.html",
  });
  assert.deepEqual(calls.filter((call) => Array.isArray(call)).map((call) => call[0]), [
    "launchMainAppUserMode",
    "waitForAnyRemoteDebugPageTarget",
    "navigateRemoteDebugPageTarget",
    "waitForRemoteDebugTarget",
    "syncPortalGlobalState",
    "bootstrapViaPageBridge",
    "reloadPortalTarget",
    "waitForRemoteDebugTarget",
    "waitForRemoteDebugTarget",
    "showOfficialWindowTarget",
  ]);
  assert.deepEqual(result.shownOfficialWindow, {
    ok: true,
    method: "SF.windowMgr.show",
    id: "0",
    nativeWindowState: {
      ok: true,
      visible: true,
      windowCount: 0,
      windowNames: [],
    },
  });
});

test("VpnService.repairOfficialUi closes connect_notfound residuals instead of cloning service targets", async () => {
  const calls = [];
  let notfoundClosed = false;
  const fakeRuntime = {
    async describeActiveSession() {
      return {
        token: "secret-token",
        sessionId: "session-1",
      };
    },
    async getLoginStatus() {
      return { status: "1" };
    },
    async getServiceState() {
      return { base: "18", l3vpn: "18", tcp: "43" };
    },
    async getLocalRuntimeInfo() {
      return { enableAutoLogin: 0 };
    },
    async getRemoteDebugTargets() {
      return [
        ...(
          notfoundClosed
            ? []
            : [
                {
                  id: "notfound-target",
                  type: "page",
                  title: "EasyConnect",
                  url: "file:///Applications/EasyConnect.app/Contents/Resources/Web/local/connect_notfound/connect_notfound.html?from=https%3A%2F%2F198.51.100.20%3A9898%2Fportal%2F%23!%2Fservice",
                  webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/notfound-target",
                },
              ]
        ),
        {
          id: "status-target",
          type: "page",
          title: "EasyConnect",
          url: "file:///Applications/EasyConnect.app/Contents/Resources/Web/local/vpn_status_manager/vpn_status_manager.html",
          webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/status-target",
        },
        {
          id: "service-a",
          type: "page",
          title: "EasyConnect",
          url: "https://198.51.100.20:9898/portal/#!/service",
          webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/service-a",
        },
        {
          id: "service-b",
          type: "page",
          title: "EasyConnect",
          url: "https://198.51.100.20:9898/portal/#!/service",
          webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/service-b",
        },
      ];
    },
    async evaluateOnRemoteDebugPageTarget(target) {
      const visible = !notfoundClosed && target.id === "notfound-target";
      const bodyText = target.id === "notfound-target" ? "连接失败 请尝试刷新后重试" : "资源搜索 默认资源组";
      return {
        evaluation: {
          result: {
            value: {
              href: target.url,
              title: target.title,
              visibilityState: visible ? "visible" : "hidden",
              hidden: !visible,
              bodyText,
            },
          },
        },
      };
    },
    async getBundleSettingPath() {
      return "/Applications/EasyConnect.app/Contents/Resources/conf/setting_demo.json";
    },
    async getPort() {
      return 54530;
    },
    async describeLatestCachedToken() {
      return {};
    },
    async getGatewayCandidates() {
      return [];
    },
    async navigatePortalRoute(targetUrlPart, targetUrl, options) {
      calls.push(["navigatePortalRoute", targetUrlPart, targetUrl, options.remoteDebugPort]);
      return { ok: true, href: targetUrl };
    },
    async waitForRemoteDebugTarget(targetUrlPart, options) {
      calls.push(["waitForRemoteDebugTarget", targetUrlPart, options.remoteDebugPort]);
      return { id: "service-a", url: "https://198.51.100.20:9898/portal/#!/service" };
    },
    async syncPortalGlobalState(targetUrlPart, context, options) {
      calls.push(["syncPortalGlobalState", targetUrlPart, context.sessionId, context.gatewayHost, context.gatewayPort, options.profile]);
      return { ok: true };
    },
    async bootstrapViaPageBridge(targetUrlPart, context, options) {
      calls.push(["bootstrapViaPageBridge", targetUrlPart, context.sessionId, options.remoteDebugPort]);
      return { ok: true, token: "derived-token" };
    },
    async reloadPortalTarget(targetUrlPart, options) {
      calls.push(["reloadPortalTarget", targetUrlPart, options.remoteDebugPort]);
      return { ok: true, href: "https://198.51.100.20:9898/portal/#!/service" };
    },
    async navigateRemoteDebugTarget(targetUrlPart, targetUrl, options) {
      calls.push(["navigateRemoteDebugTarget", targetUrlPart, targetUrl, options.remoteDebugPort]);
      return { ok: true, requestedUrl: targetUrl };
    },
    async closeOfficialWindowTarget(targetUrlPart, options) {
      calls.push(["closeOfficialWindowTarget", targetUrlPart, options.remoteDebugPort]);
      if (targetUrlPart === "notfound-target") {
        notfoundClosed = true;
      }
      return { ok: true, closedBy: "official-window-api" };
    },
    async bringRemoteDebugTargetToFront(targetUrlPart, options) {
      calls.push(["bringRemoteDebugTargetToFront", targetUrlPart, options.remoteDebugPort]);
      return { ok: true, targetUrlPart };
    },
    appExecutable: "/Applications/EasyConnect.app/Contents/MacOS/EasyConnect",
  };

  const service = new VpnService({
    runtimeFactory: () => fakeRuntime,
    existsFn: async () => true,
  });

  const config = {
    vpn: {
      username: "demo-user",
      remoteDebugPort: 9222,
      gateways: [{ host: "198.51.100.20", port: 9898 }],
    },
  };
  const result = await service.repairOfficialUi(config);

  assert.equal(result.action, "repair-official-ui");
  assert.deepEqual(calls.filter((call) => Array.isArray(call) && call[0] === "navigatePortalRoute"), []);
  assert.deepEqual(calls.filter((call) => Array.isArray(call) && call[0] === "closeOfficialWindowTarget").map((call) => call[1]), [
    "notfound-target",
  ]);
  assert.deepEqual(calls.filter((call) => Array.isArray(call) && call[0] === "navigateRemoteDebugTarget"), []);
  assert.deepEqual(calls.filter((call) => Array.isArray(call) && call[0] === "bringRemoteDebugTargetToFront"), []);
  assert.equal(result.focusedServiceTarget, null);
  assert.deepEqual(result.closedResidualTargets.map((target) => [target.id, target.kind]), [
    ["notfound-target", "probe-failed"],
  ]);
  assert.deepEqual(result.repairedResidualTargets, []);

  calls.length = 0;
  notfoundClosed = false;
  const focusedResult = await service.repairOfficialUi(config, { focusServiceTarget: true });
  assert.equal(focusedResult.action, "repair-official-ui");
  assert.deepEqual(calls.filter((call) => Array.isArray(call) && call[0] === "bringRemoteDebugTargetToFront"), [
    ["bringRemoteDebugTargetToFront", "service-a", 9222],
  ]);
});

test("VpnService.repairOfficialUi closes a hidden connect_notfound residual when service target exists", async () => {
  const calls = [];
  const notfoundUrl =
    "file:///Applications/EasyConnect.app/Contents/Resources/Web/local/connect_notfound/connect_notfound.html?from=https%3A%2F%2F198.51.100.20%3A9898%2Fportal%2F%23!%2Flogin";
  const fakeRuntime = {
    async describeActiveSession() {
      return {
        token: "secret-token",
        sessionId: "session-1",
      };
    },
    async getLoginStatus() {
      return { status: "1" };
    },
    async getServiceState() {
      return { base: "18", l3vpn: "18", tcp: "43" };
    },
    async getLocalRuntimeInfo() {
      return { enableAutoLogin: 0 };
    },
    async getRemoteDebugTargets() {
      return [
        {
          id: "service-target",
          type: "page",
          title: "EasyConnect",
          url: "https://198.51.100.20:9898/portal/#!/service",
          webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/service-target",
        },
        {
          id: "notfound-target",
          type: "page",
          title: "EasyConnect",
          url: notfoundUrl,
          webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/notfound-target",
        },
        {
          id: "status-target",
          type: "page",
          title: "EasyConnect",
          url: "file:///Applications/EasyConnect.app/Contents/Resources/Web/local/vpn_status_manager/vpn_status_manager.html",
          webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/status-target",
        },
      ];
    },
    async evaluateOnRemoteDebugPageTarget(target) {
      return {
        evaluation: {
          result: {
            value: {
              href: target.url,
              title: target.title,
              visibilityState: target.id === "status-target" ? "visible" : "hidden",
              hidden: target.id !== "status-target",
              bodyText: target.id === "service-target" ? "资源搜索 默认资源组" : "",
            },
          },
        },
      };
    },
    async getBundleSettingPath() {
      return "/Applications/EasyConnect.app/Contents/Resources/conf/setting_demo.json";
    },
    async getPort() {
      return 54530;
    },
    async describeLatestCachedToken() {
      return {};
    },
    async getGatewayCandidates() {
      return [];
    },
    async waitForRemoteDebugTarget(targetUrlPart, options) {
      calls.push(["waitForRemoteDebugTarget", targetUrlPart, options.remoteDebugPort]);
      return { id: "service-target", url: "https://198.51.100.20:9898/portal/#!/service" };
    },
    async syncPortalGlobalState(targetUrlPart, context, options) {
      calls.push(["syncPortalGlobalState", targetUrlPart, context.sessionId, context.gatewayHost, context.gatewayPort, options.profile]);
      return { ok: true };
    },
    async bootstrapViaPageBridge(targetUrlPart, context, options) {
      calls.push(["bootstrapViaPageBridge", targetUrlPart, context.sessionId, options.remoteDebugPort]);
      return { ok: true, token: "derived-token" };
    },
    async reloadPortalTarget(targetUrlPart, options) {
      calls.push(["reloadPortalTarget", targetUrlPart, options.remoteDebugPort]);
      return { ok: true, href: "https://198.51.100.20:9898/portal/#!/service" };
    },
    async navigateRemoteDebugTarget(targetUrlPart, targetUrl, options) {
      calls.push(["navigateRemoteDebugTarget", targetUrlPart, targetUrl, options.remoteDebugPort]);
      return { ok: true, requestedUrl: targetUrl };
    },
    async closeOfficialWindowTarget(targetUrlPart, options) {
      calls.push(["closeOfficialWindowTarget", targetUrlPart, options.remoteDebugPort]);
      return { ok: true, closedBy: "official-window-api" };
    },
    async bringRemoteDebugTargetToFront(targetUrlPart, options) {
      calls.push(["bringRemoteDebugTargetToFront", targetUrlPart, options.remoteDebugPort]);
      return { ok: true, targetUrlPart };
    },
    appExecutable: "/Applications/EasyConnect.app/Contents/MacOS/EasyConnect",
  };

  const service = new VpnService({
    runtimeFactory: () => fakeRuntime,
    existsFn: async () => true,
  });

  const result = await service.repairOfficialUi(
    {
      vpn: {
        username: "demo-user",
        remoteDebugPort: 9222,
        gateways: [{ host: "198.51.100.20", port: 9898 }],
      },
    },
    { onlineAction: "relogin-page-bridge" },
  );

  assert.equal(result.action, "repair-official-ui");
  assert.deepEqual(
    calls.filter((call) => Array.isArray(call) && call[0] === "closeOfficialWindowTarget"),
    [
      [
        "closeOfficialWindowTarget",
        "notfound-target",
        9222,
      ],
    ],
  );
  assert.deepEqual(calls.filter((call) => Array.isArray(call) && call[0] === "navigateRemoteDebugTarget"), []);
  assert.deepEqual(result.closedResidualTargets.map((target) => [target.id, target.kind]), [
    ["notfound-target", "probe-failed"],
  ]);
  assert.deepEqual(result.repairedResidualTargets, []);
});

test("VpnService.repairOfficialUi closes duplicate service targets created by relogin recovery", async () => {
  const calls = [];
  let nativeWindowCount = 2;
  const fakeRuntime = {
    async describeActiveSession() {
      return {
        token: "secret-token",
        sessionId: "session-1",
      };
    },
    async getLoginStatus() {
      return { status: "1" };
    },
    async getServiceState() {
      return { base: "18", l3vpn: "18", tcp: "43" };
    },
    async getLocalRuntimeInfo() {
      return { enableAutoLogin: 0 };
    },
    async getRemoteDebugTargets() {
      return [
        {
          id: "service-visible",
          type: "page",
          title: "EasyConnect",
          url: "https://198.51.100.20:9898/portal/#!/service",
          webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/service-visible",
        },
        {
          id: "service-duplicate",
          type: "page",
          title: "EasyConnect",
          url: "https://198.51.100.20:9898/portal/#!/service",
          webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/service-duplicate",
        },
        {
          id: "status-target",
          type: "page",
          title: "EasyConnect",
          url: "file:///Applications/EasyConnect.app/Contents/Resources/Web/local/vpn_status_manager/vpn_status_manager.html",
          webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/status-target",
        },
      ];
    },
    async evaluateOnRemoteDebugPageTarget(target) {
      return {
        evaluation: {
          result: {
            value: {
              href: target.url,
              title: target.title,
              visibilityState: target.id === "service-visible" ? "visible" : "hidden",
              hidden: target.id !== "service-visible",
              bodyText: target.id.startsWith("service") ? "资源搜索 默认资源组" : "",
            },
          },
        },
      };
    },
    async getBundleSettingPath() {
      return "/Applications/EasyConnect.app/Contents/Resources/conf/setting_demo.json";
    },
    async getPort() {
      return 54530;
    },
    async describeLatestCachedToken() {
      return {};
    },
    async getGatewayCandidates() {
      return [];
    },
    async waitForRemoteDebugTarget(targetUrlPart, options) {
      calls.push(["waitForRemoteDebugTarget", targetUrlPart, options.remoteDebugPort]);
      return { id: "service-visible", url: "https://198.51.100.20:9898/portal/#!/service" };
    },
    async syncPortalGlobalState(targetUrlPart, context, options) {
      calls.push(["syncPortalGlobalState", targetUrlPart, context.sessionId, context.gatewayHost, context.gatewayPort, options.profile]);
      return { ok: true };
    },
    async bootstrapViaPageBridge(targetUrlPart, context, options) {
      calls.push(["bootstrapViaPageBridge", targetUrlPart, context.sessionId, options.remoteDebugPort]);
      return { ok: true, token: "derived-token" };
    },
    async reloadPortalTarget(targetUrlPart, options) {
      calls.push(["reloadPortalTarget", targetUrlPart, options.remoteDebugPort]);
      return { ok: true, href: "https://198.51.100.20:9898/portal/#!/service" };
    },
    async navigateRemoteDebugTarget(targetUrlPart, targetUrl, options) {
      calls.push(["navigateRemoteDebugTarget", targetUrlPart, targetUrl, options.remoteDebugPort]);
      return { ok: true, requestedUrl: targetUrl };
    },
    async closeOfficialWindowTarget(targetUrlPart, options) {
      calls.push(["closeOfficialWindowTarget", targetUrlPart, options.remoteDebugPort]);
      nativeWindowCount = 1;
      return { ok: true, closedBy: "official-window-api" };
    },
    async getOfficialNativeWindowState() {
      return {
        ok: true,
        visible: true,
        windowCount: nativeWindowCount,
        windowNames: Array.from({ length: nativeWindowCount }, () => "EasyConnect"),
      };
    },
    appExecutable: "/Applications/EasyConnect.app/Contents/MacOS/EasyConnect",
  };

  const service = new VpnService({
    runtimeFactory: () => fakeRuntime,
    existsFn: async () => true,
  });

  const result = await service.repairOfficialUi(
    {
      vpn: {
        username: "demo-user",
        remoteDebugPort: 9222,
        gateways: [{ host: "198.51.100.20", port: 9898 }],
      },
    },
    { onlineAction: "relogin-page-bridge" },
  );

  assert.equal(result.action, "repair-official-ui");
  assert.deepEqual(calls.filter((call) => Array.isArray(call) && call[0] === "closeOfficialWindowTarget"), [
    ["closeOfficialWindowTarget", "service-duplicate", 9222],
  ]);
  assert.deepEqual(calls.filter((call) => Array.isArray(call) && call[0] === "navigateRemoteDebugTarget"), []);
  assert.deepEqual(result.closedResidualTargets.map((target) => [target.id, target.kind, target.originalKind]), [
    ["service-duplicate", "duplicate-service", "service"],
  ]);
  assert.equal(result.status.officialUi.nativeWindowState.windowCount, 1);
});

test("VpnService.repairOfficialUi closes duplicate service targets in background without native activation", async () => {
  const calls = [];
  const closedTargets = new Set();
  let nativeWindowCount = 3;
  const serviceTargets = [
    {
      id: "service-visible",
      type: "page",
      title: "EasyConnect",
      url: "https://198.51.100.20:9898/portal/#!/service",
      webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/service-visible",
    },
    {
      id: "service-duplicate-a",
      type: "page",
      title: "EasyConnect",
      url: "https://198.51.100.20:9898/portal/#!/service",
      webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/service-duplicate-a",
    },
    {
      id: "service-duplicate-b",
      type: "page",
      title: "EasyConnect",
      url: "https://198.51.100.20:9898/portal/#!/service",
      webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/service-duplicate-b",
    },
  ];
  const fakeRuntime = {
    async describeActiveSession() {
      return {
        token: "secret-token",
        sessionId: "session-1",
      };
    },
    async getLoginStatus() {
      return { status: "1" };
    },
    async getServiceState() {
      return { base: "18", l3vpn: "18", tcp: "43" };
    },
    async getLocalRuntimeInfo() {
      return { enableAutoLogin: 0 };
    },
    async getRemoteDebugTargets() {
      return serviceTargets.filter((target) => !closedTargets.has(target.id));
    },
    async evaluateOnRemoteDebugPageTarget(target) {
      return {
        evaluation: {
          result: {
            value: {
              href: target.url,
              title: target.title,
              visibilityState: target.id === "service-visible" ? "visible" : "hidden",
              hidden: target.id !== "service-visible",
              bodyText: "资源搜索 默认资源组",
            },
          },
        },
      };
    },
    async getBundleSettingPath() {
      return "/Applications/EasyConnect.app/Contents/Resources/conf/setting_demo.json";
    },
    async getPort() {
      return 54530;
    },
    async describeLatestCachedToken() {
      return {};
    },
    async getGatewayCandidates() {
      return [];
    },
    async waitForRemoteDebugTarget(targetUrlPart, options) {
      calls.push(["waitForRemoteDebugTarget", targetUrlPart, options.remoteDebugPort]);
      return { id: "service-visible", url: "https://198.51.100.20:9898/portal/#!/service" };
    },
    async syncPortalGlobalState(targetUrlPart, context, options) {
      calls.push(["syncPortalGlobalState", targetUrlPart, context.sessionId, context.gatewayHost, context.gatewayPort, options.profile]);
      return { ok: true };
    },
    async bootstrapViaPageBridge(targetUrlPart, context, options) {
      calls.push(["bootstrapViaPageBridge", targetUrlPart, context.sessionId, options.remoteDebugPort]);
      return { ok: true, token: "derived-token" };
    },
    async reloadPortalTarget(targetUrlPart, options) {
      calls.push(["reloadPortalTarget", targetUrlPart, options.remoteDebugPort]);
      return { ok: true, href: "https://198.51.100.20:9898/portal/#!/service" };
    },
    async closeOfficialWindowTarget(targetUrlPart, options) {
      calls.push(["closeOfficialWindowTarget", targetUrlPart, options.remoteDebugPort, options.allowNativeWindowActivation]);
      closedTargets.add(targetUrlPart);
      nativeWindowCount = Math.max(1, nativeWindowCount - 1);
      return { ok: true, closedBy: "official-window-api" };
    },
    async closeExtraOfficialNativeWindows(options) {
      calls.push(["closeExtraOfficialNativeWindows", options.remoteDebugPort, options.allowNativeWindowActivation]);
      return { ok: false, error: "should not activate native windows" };
    },
    async showOfficialWindowTarget(targetUrlPart, options) {
      calls.push(["showOfficialWindowTarget", targetUrlPart, options.remoteDebugPort, options.allowNativeWindowActivation]);
      return { ok: false, error: "should not show native windows" };
    },
    async getOfficialNativeWindowState() {
      return {
        ok: true,
        visible: true,
        windowCount: nativeWindowCount,
        windowNames: Array.from({ length: nativeWindowCount }, () => "EasyConnect"),
      };
    },
    appExecutable: "/Applications/EasyConnect.app/Contents/MacOS/EasyConnect",
  };

  const service = new VpnService({
    runtimeFactory: () => fakeRuntime,
    existsFn: async () => true,
  });

  const result = await service.repairOfficialUi(
    {
      vpn: {
        username: "demo-user",
        remoteDebugPort: 9222,
        gateways: [{ host: "198.51.100.20", port: 9898 }],
      },
    },
    { allowNativeWindowActivation: false, onlineAction: "already-online" },
  );

  assert.equal(result.action, "repair-official-ui");
  assert.deepEqual(calls.filter((call) => Array.isArray(call) && call[0] === "closeOfficialWindowTarget"), [
    ["closeOfficialWindowTarget", "service-duplicate-a", 9222, false],
    ["closeOfficialWindowTarget", "service-duplicate-b", 9222, false],
  ]);
  assert.deepEqual(calls.filter((call) => Array.isArray(call) && call[0] === "closeExtraOfficialNativeWindows"), []);
  assert.deepEqual(calls.filter((call) => Array.isArray(call) && call[0] === "showOfficialWindowTarget"), []);
  assert.deepEqual(result.closedResidualTargets.map((target) => [target.id, target.kind, target.originalKind]), [
    ["service-duplicate-a", "duplicate-service", "service"],
    ["service-duplicate-b", "duplicate-service", "service"],
  ]);
  assert.equal(result.status.officialUi.nativeWindowState.windowCount, 1);
});

test("VpnService.repairOfficialUi does not close a service target when it is the only native EasyConnect window", async () => {
  const calls = [];
  const fakeRuntime = {
    async describeActiveSession() {
      return {
        token: "secret-token",
        sessionId: "session-1",
      };
    },
    async getLoginStatus() {
      return { status: "1" };
    },
    async getServiceState() {
      return { base: "18", l3vpn: "18", tcp: "43" };
    },
    async getLocalRuntimeInfo() {
      return { enableAutoLogin: 0 };
    },
    async getRemoteDebugTargets() {
      return [
        {
          id: "login-bridge",
          type: "page",
          title: "EasyConnect",
          url: "https://198.51.100.20:9898/portal/#!/login",
          webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/login-bridge",
        },
        {
          id: "old-service",
          type: "page",
          title: "EasyConnect",
          url: "https://198.51.100.20:9898/portal/#!/service",
          webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/old-service",
        },
      ];
    },
    async evaluateOnRemoteDebugPageTarget(target) {
      return {
        evaluation: {
          result: {
            value: {
              href: target.url,
              title: target.title,
              visibilityState: "hidden",
              hidden: true,
              bodyText: target.id === "old-service" ? "资源搜索 默认资源组" : "用户名 密码 登录",
            },
          },
        },
      };
    },
    async getBundleSettingPath() {
      return "/Applications/EasyConnect.app/Contents/Resources/conf/setting_demo.json";
    },
    async getPort() {
      return 54530;
    },
    async describeLatestCachedToken() {
      return {};
    },
    async getGatewayCandidates() {
      return [];
    },
    async waitForRemoteDebugTarget(targetUrlPart, options) {
      calls.push(["waitForRemoteDebugTarget", targetUrlPart, options.remoteDebugPort]);
      return { id: "old-service", url: "https://198.51.100.20:9898/portal/#!/service" };
    },
    async syncPortalGlobalState(targetUrlPart, context, options) {
      calls.push(["syncPortalGlobalState", targetUrlPart, context.sessionId, context.gatewayHost, context.gatewayPort, options.profile]);
      return { ok: true };
    },
    async bootstrapViaPageBridge(targetUrlPart, context, options) {
      calls.push(["bootstrapViaPageBridge", targetUrlPart, context.sessionId, options.remoteDebugPort]);
      return { ok: true, token: "derived-token" };
    },
    async reloadPortalTarget(targetUrlPart, options) {
      calls.push(["reloadPortalTarget", targetUrlPart, options.remoteDebugPort]);
      return { ok: true, href: "https://198.51.100.20:9898/portal/#!/service" };
    },
    async closeOfficialWindowTarget(targetUrlPart, options) {
      calls.push(["closeOfficialWindowTarget", targetUrlPart, options.remoteDebugPort]);
      return { ok: true, closedBy: "official-window-api" };
    },
    async getOfficialNativeWindowState() {
      return { ok: true, visible: true, windowCount: 1, windowNames: ["EasyConnect"] };
    },
    appExecutable: "/Applications/EasyConnect.app/Contents/MacOS/EasyConnect",
  };

  const service = new VpnService({
    runtimeFactory: () => fakeRuntime,
    existsFn: async () => true,
  });

  const result = await service.repairOfficialUi(
    {
      vpn: {
        username: "demo-user",
        remoteDebugPort: 9222,
        gateways: [{ host: "198.51.100.20", port: 9898 }],
      },
    },
    { onlineAction: "relogin-page-bridge" },
  );

  assert.equal(result.action, "repair-official-ui");
  assert.deepEqual(calls.filter((call) => Array.isArray(call) && call[0] === "closeOfficialWindowTarget"), []);
  assert.deepEqual(result.closedResidualTargets.map((target) => [target.id, target.kind, target.result.action]), [
    ["old-service", "pre-relogin-service", "skipped-native-window-count"],
  ]);
});

test("VpnService.repairOfficialUi closes an online stale connect target in background when service exists", async () => {
  const calls = [];
  const closedTargets = new Set();
  let closeShouldFail = false;
  let nativeWindowCountOverride = null;
  const targets = [
    {
      id: "service-target",
      type: "page",
      title: "EasyConnect",
      url: "https://198.51.100.20:9898/portal/#!/service",
      webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/service-target",
    },
    {
      id: "connect-target",
      type: "page",
      title: "EasyConnect",
      url: "file:///Applications/EasyConnect.app/Contents/Resources/Web/local/connect/connect.html",
      webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/connect-target",
    },
  ];
  const fakeRuntime = {
    async describeActiveSession() {
      return {
        token: "secret-token",
        sessionId: "session-1",
      };
    },
    async getLoginStatus() {
      return { status: "1" };
    },
    async getServiceState() {
      return { base: "18", l3vpn: "18", tcp: "43" };
    },
    async getLocalRuntimeInfo() {
      return { enableAutoLogin: 0 };
    },
    async getRemoteDebugTargets() {
      return targets.filter((target) => !closedTargets.has(target.id));
    },
    async evaluateOnRemoteDebugPageTarget(target) {
      return {
        evaluation: {
          result: {
            value: {
              href: target.url,
              title: target.title,
              visibilityState: "visible",
              hidden: false,
              bodyText: target.id === "service-target" ? "资源搜索 默认资源组" : "",
            },
          },
        },
      };
    },
    async getBundleSettingPath() {
      return "/Applications/EasyConnect.app/Contents/Resources/conf/setting_demo.json";
    },
    async getPort() {
      return 54530;
    },
    async describeLatestCachedToken() {
      return {};
    },
    async getGatewayCandidates() {
      return [];
    },
    async waitForRemoteDebugTarget(targetUrlPart, options) {
      calls.push(["waitForRemoteDebugTarget", targetUrlPart, options.remoteDebugPort]);
      return targets[0];
    },
    async syncPortalGlobalState(targetUrlPart, context, options) {
      calls.push(["syncPortalGlobalState", targetUrlPart, context.sessionId, options.profile]);
      return { ok: true };
    },
    async bootstrapViaPageBridge(targetUrlPart, context, options) {
      calls.push(["bootstrapViaPageBridge", targetUrlPart, context.sessionId, options.remoteDebugPort]);
      return { ok: true, token: "derived-token" };
    },
    async reloadPortalTarget(targetUrlPart, options) {
      calls.push(["reloadPortalTarget", targetUrlPart, options.remoteDebugPort]);
      return { ok: true, href: targets[0].url };
    },
    async closeOfficialWindowTarget(targetId, options) {
      calls.push(["closeOfficialWindowTarget", targetId, options.remoteDebugPort, options.allowNativeWindowActivation]);
      if (closeShouldFail) {
        return { ok: false, error: "official close failed" };
      }
      closedTargets.add(targetId);
      return { ok: true, closedBy: "official-window-api" };
    },
    async showOfficialWindowTarget(targetId, options) {
      calls.push(["showOfficialWindowTarget", targetId, options.remoteDebugPort, options.allowNativeWindowActivation]);
      return { ok: false, error: "should not activate native windows" };
    },
    async navigateRemoteDebugTarget(targetId, targetUrl) {
      calls.push(["navigateRemoteDebugTarget", targetId, targetUrl]);
      return { ok: true };
    },
    async getOfficialNativeWindowState() {
      const repaired = closedTargets.has("connect-target");
      const windowCount = nativeWindowCountOverride ?? (repaired ? 1 : 0);
      return {
        ok: true,
        visible: true,
        windowCount,
        windowNames: windowCount > 0 ? ["EasyConnect"] : [],
      };
    },
    appExecutable: "/Applications/EasyConnect.app/Contents/MacOS/EasyConnect",
  };

  const service = new VpnService({
    runtimeFactory: () => fakeRuntime,
    existsFn: async () => true,
  });

  const result = await service.repairOfficialUi(
    {
      vpn: {
        username: "demo-user",
        remoteDebugPort: 9222,
        gateways: [{ host: "198.51.100.20", port: 9898 }],
      },
    },
    {
      allowNativeWindowActivation: false,
      onlineAction: "relogin-page-bridge",
    },
  );

  assert.equal(result.action, "repair-official-ui");
  assert.deepEqual(calls.filter((call) => Array.isArray(call) && call[0] === "closeOfficialWindowTarget"), [
    ["closeOfficialWindowTarget", "connect-target", 9222, false],
  ]);
  assert.deepEqual(calls.filter((call) => Array.isArray(call) && call[0] === "showOfficialWindowTarget"), []);
  assert.deepEqual(result.closedResidualTargets.map((target) => [target.id, target.kind]), [
    ["connect-target", "stale-connect"],
  ]);
  assert.equal(result.status.officialUi.nativeWindowState.windowCount, 1);
  assert.equal(result.status.officialUi.needsNativeWindowRestore, false);

  calls.length = 0;
  closedTargets.clear();
  closeShouldFail = true;
  nativeWindowCountOverride = 1;
  const failed = await service.repairOfficialUi(
    {
      vpn: {
        username: "demo-user",
        remoteDebugPort: 9222,
        gateways: [{ host: "198.51.100.20", port: 9898 }],
      },
    },
    {
      allowNativeWindowActivation: true,
      allowLoginFallbackNavigation: false,
      onlineAction: "relogin-page-bridge",
    },
  );

  assert.equal(failed.action, "repair-official-ui-incomplete");
  assert.match(failed.reason, /close|residual/i);
  assert.deepEqual(
    failed.closedResidualTargets.map((target) => [target.id, target.kind, target.result.ok]),
    [["connect-target", "stale-connect", false]],
  );
  assert.equal(
    failed.status.officialUi.targets.some((target) => target.id === "connect-target" && target.visible),
    true,
  );
  assert.equal(failed.safeFallback?.action, "skip-official-ui-login-fallback-disabled");
  assert.deepEqual(calls.filter((call) => Array.isArray(call) && call[0] === "navigateRemoteDebugTarget"), []);

  calls.length = 0;
  closedTargets.clear();
  closeShouldFail = false;
  nativeWindowCountOverride = 0;
  const deferred = await service.repairOfficialUi(
    {
      vpn: {
        username: "demo-user",
        remoteDebugPort: 9222,
        gateways: [{ host: "198.51.100.20", port: 9898 }],
      },
    },
    {
      allowNativeWindowActivation: false,
      onlineAction: "relogin-page-bridge",
    },
  );

  assert.equal(deferred.action, "skip-native-window-activation-background");
  assert.deepEqual(deferred.closedResidualTargets.map((target) => [target.id, target.kind]), [
    ["connect-target", "stale-connect"],
  ]);
  assert.equal(deferred.status.officialUi.needsNativeWindowRestore, true);
  assert.deepEqual(calls.filter((call) => Array.isArray(call) && call[0] === "showOfficialWindowTarget"), []);
  assert.deepEqual(calls.filter((call) => Array.isArray(call) && call[0] === "navigateRemoteDebugTarget"), []);
});

test("VpnService.repairOfficialUi waits for delayed stale-target and native-window convergence", async () => {
  const calls = [];
  const delays = [];
  let settled = false;
  const serviceTarget = {
    id: "service-target",
    type: "page",
    title: "EasyConnect",
    url: "https://198.51.100.20:9898/portal/#!/service",
    webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/service-target",
  };
  const connectTargets = ["connect-a", "connect-b"].map((id) => ({
    id,
    type: "page",
    title: "EasyConnect",
    url: "file:///Applications/EasyConnect.app/Contents/Resources/Web/local/connect/connect.html",
    webSocketDebuggerUrl: `ws://127.0.0.1/devtools/page/${id}`,
  }));
  const fakeRuntime = {
    async describeActiveSession() {
      return { token: "secret-token", sessionId: "session-1" };
    },
    async getLoginStatus() {
      return { status: "1" };
    },
    async getServiceState() {
      return { base: "18", l3vpn: "18", tcp: "43" };
    },
    async getLocalRuntimeInfo() {
      return { enableAutoLogin: 0 };
    },
    async getRemoteDebugTargets() {
      return settled ? [serviceTarget] : [serviceTarget, ...connectTargets];
    },
    async evaluateOnRemoteDebugPageTarget(target) {
      return {
        evaluation: {
          result: {
            value: {
              href: target.url,
              title: target.title,
              visibilityState: "visible",
              hidden: false,
              bodyText: target.id === serviceTarget.id ? "资源搜索 默认资源组" : "",
            },
          },
        },
      };
    },
    async getBundleSettingPath() {
      return "/Applications/EasyConnect.app/Contents/Resources/conf/setting_demo.json";
    },
    async getPort() {
      return 54530;
    },
    async describeLatestCachedToken() {
      return {};
    },
    async getGatewayCandidates() {
      return [];
    },
    async waitForRemoteDebugTarget() {
      return serviceTarget;
    },
    async syncPortalGlobalState() {
      return { ok: true };
    },
    async bootstrapViaPageBridge() {
      return { ok: true, token: "derived-token" };
    },
    async reloadPortalTarget() {
      return { ok: true, href: serviceTarget.url };
    },
    async closeOfficialWindowTarget(targetId) {
      calls.push(["closeOfficialWindowTarget", targetId]);
      return {
        ok: true,
        value: { ok: true, method: "SF.windowMgr.close", containerId: "0" },
      };
    },
    async showOfficialWindowTarget(targetId) {
      calls.push(["showOfficialWindowTarget", targetId]);
      return { ok: true, method: "SF.windowMgr.show", id: "0" };
    },
    async getOfficialNativeWindowState() {
      return {
        ok: true,
        visible: true,
        windowCount: settled ? 1 : 0,
        windowNames: settled ? ["EasyConnect"] : [],
      };
    },
    appExecutable: "/Applications/EasyConnect.app/Contents/MacOS/EasyConnect",
  };
  const service = new VpnService({
    runtimeFactory: () => fakeRuntime,
    existsFn: async () => true,
    delayFn: async (ms) => {
      delays.push(ms);
      settled = true;
    },
  });

  const result = await service.repairOfficialUi(
    {
      vpn: {
        username: "demo-user",
        remoteDebugPort: 9222,
        gateways: [{ host: "198.51.100.20", port: 9898 }],
      },
    },
    {
      allowNativeWindowActivation: true,
      allowLoginFallbackNavigation: false,
      postRepairSettleMs: 5000,
    },
  );

  assert.equal(result.action, "repair-official-ui");
  assert.deepEqual(delays, [5000]);
  assert.deepEqual(calls.filter((call) => call[0] === "closeOfficialWindowTarget"), [
    ["closeOfficialWindowTarget", "connect-a"],
  ]);
  assert.deepEqual(calls.filter((call) => call[0] === "showOfficialWindowTarget"), [
    ["showOfficialWindowTarget", "service-target"],
  ]);
  assert.equal(result.status.officialUi.hasServiceTarget, true);
  assert.equal(result.status.officialUi.needsNativeWindowRestore, false);
  assert.equal(result.status.officialUi.targets.some((target) => target.kind === "connect"), false);
});

test("VpnService.repairOfficialUi skips background native window activation for an existing service target", async () => {
  const calls = [];
  const fakeRuntime = {
    async describeActiveSession() {
      return {
        token: "secret-token",
        sessionId: "session-1",
      };
    },
    async getLoginStatus() {
      return { status: "1" };
    },
    async getServiceState() {
      return { base: "18", l3vpn: "18", tcp: "43" };
    },
    async getLocalRuntimeInfo() {
      return { enableAutoLogin: 0 };
    },
    async getRemoteDebugTargets() {
      return [
        {
          id: "service-target",
          type: "page",
          title: "EasyConnect",
          url: "https://198.51.100.20:9898/portal/#!/vpn_openresource",
          webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/service-target",
        },
      ];
    },
    async evaluateOnRemoteDebugPageTarget(target) {
      return {
        evaluation: {
          result: {
            value: {
              href: target.url,
              title: target.title,
              visibilityState: "visible",
              hidden: false,
              bodyText: "",
            },
          },
        },
      };
    },
    async getBundleSettingPath() {
      return "/Applications/EasyConnect.app/Contents/Resources/conf/setting_demo.json";
    },
    async getPort() {
      return 54530;
    },
    async describeLatestCachedToken() {
      return {};
    },
    async getGatewayCandidates() {
      return [];
    },
    async waitForRemoteDebugTarget(targetUrlPart, options) {
      calls.push(["waitForRemoteDebugTarget", targetUrlPart, options.remoteDebugPort]);
      return { id: "service-target", url: "https://198.51.100.20:9898/portal/#!/vpn_openresource" };
    },
    async syncPortalGlobalState(targetUrlPart, context, options) {
      calls.push(["syncPortalGlobalState", targetUrlPart, context.sessionId, context.gatewayHost, context.gatewayPort, options.profile]);
      return { ok: true };
    },
    async bootstrapViaPageBridge(targetUrlPart, context, options) {
      calls.push(["bootstrapViaPageBridge", targetUrlPart, context.sessionId, options.remoteDebugPort]);
      return { ok: true, token: "derived-token" };
    },
    async reloadPortalTarget(targetUrlPart, options) {
      calls.push(["reloadPortalTarget", targetUrlPart, options.remoteDebugPort]);
      return { ok: true, href: "https://198.51.100.20:9898/portal/#!/vpn_openresource" };
    },
    async showOfficialWindowTarget(targetUrlPart, options) {
      calls.push(["showOfficialWindowTarget", targetUrlPart, options.remoteDebugPort]);
      return { ok: true, method: "SF.windowMgr.show", id: "0" };
    },
    async getOfficialNativeWindowState() {
      return { ok: true, visible: true, windowCount: 0, windowNames: [] };
    },
    appExecutable: "/Applications/EasyConnect.app/Contents/MacOS/EasyConnect",
  };

  const service = new VpnService({
    runtimeFactory: () => fakeRuntime,
    existsFn: async () => true,
  });

  const result = await service.repairOfficialUi(
    {
      vpn: {
        username: "demo-user",
        remoteDebugPort: 9222,
        gateways: [{ host: "198.51.100.20", port: 9898 }],
      },
    },
    { allowNativeWindowActivation: false },
  );

  assert.equal(result.action, "skip-native-window-activation-background");
  assert.deepEqual(calls.filter((call) => Array.isArray(call) && call[0] === "showOfficialWindowTarget"), []);
  assert.equal(result.nativeWindowActivation?.action, "skipped-background-native-window-activation");
  assert.equal(result.status.officialUi.needsNativeWindowRestore, true);
});

test("VpnService.repairOfficialUi validates missing native window convergence after show", async () => {
  const calls = [];
  const delays = [];
  let showRequested = false;
  let settled = false;
  let shouldConverge = true;
  const fakeRuntime = {
    async describeActiveSession() {
      return {
        token: "secret-token",
        sessionId: "session-1",
      };
    },
    async getLoginStatus() {
      return { status: "1" };
    },
    async getServiceState() {
      return { base: "18", l3vpn: "18", tcp: "43" };
    },
    async getLocalRuntimeInfo() {
      return { enableAutoLogin: 0 };
    },
    async getRemoteDebugTargets() {
      return [
        {
          id: "service-target",
          type: "page",
          title: "EasyConnect",
          url: "https://198.51.100.20:9898/portal/#!/vpn_openresource",
          webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/service-target",
        },
      ];
    },
    async evaluateOnRemoteDebugPageTarget(target) {
      return {
        evaluation: {
          result: {
            value: {
              href: target.url,
              title: target.title,
              visibilityState: "visible",
              hidden: false,
              bodyText: "",
            },
          },
        },
      };
    },
    async getBundleSettingPath() {
      return "/Applications/EasyConnect.app/Contents/Resources/conf/setting_demo.json";
    },
    async getPort() {
      return 54530;
    },
    async describeLatestCachedToken() {
      return {};
    },
    async getGatewayCandidates() {
      return [];
    },
    async waitForRemoteDebugTarget(targetUrlPart, options) {
      calls.push(["waitForRemoteDebugTarget", targetUrlPart, options.remoteDebugPort]);
      return { id: "service-target", url: "https://198.51.100.20:9898/portal/#!/vpn_openresource" };
    },
    async syncPortalGlobalState(targetUrlPart, context, options) {
      calls.push(["syncPortalGlobalState", targetUrlPart, context.sessionId, context.gatewayHost, context.gatewayPort, options.profile]);
      return { ok: true };
    },
    async bootstrapViaPageBridge(targetUrlPart, context, options) {
      calls.push(["bootstrapViaPageBridge", targetUrlPart, context.sessionId, options.remoteDebugPort]);
      return { ok: true, token: "derived-token" };
    },
    async reloadPortalTarget(targetUrlPart, options) {
      calls.push(["reloadPortalTarget", targetUrlPart, options.remoteDebugPort]);
      return { ok: true, href: "https://198.51.100.20:9898/portal/#!/vpn_openresource" };
    },
    async navigateRemoteDebugTarget(targetUrlPart, targetUrl, options) {
      calls.push(["navigateRemoteDebugTarget", targetUrlPart, targetUrl, options.remoteDebugPort]);
      return { ok: true, requestedUrl: targetUrl };
    },
    async showOfficialWindowTarget(targetUrlPart, options) {
      calls.push(["showOfficialWindowTarget", targetUrlPart, options.remoteDebugPort]);
      showRequested = true;
      return { ok: true, method: "SF.windowMgr.show", id: "0" };
    },
    async getOfficialNativeWindowState() {
      const restored = showRequested && settled && shouldConverge;
      return {
        ok: true,
        visible: true,
        windowCount: restored ? 1 : 0,
        windowNames: restored ? ["EasyConnect"] : [],
      };
    },
    appExecutable: "/Applications/EasyConnect.app/Contents/MacOS/EasyConnect",
  };

  const service = new VpnService({
    runtimeFactory: () => fakeRuntime,
    existsFn: async () => true,
    delayFn: async (ms) => {
      delays.push(ms);
      settled = true;
    },
  });

  const config = {
    vpn: {
      username: "demo-user",
      remoteDebugPort: 9222,
      gateways: [{ host: "198.51.100.20", port: 9898 }],
    },
  };
  const result = await service.repairOfficialUi(config);

  assert.equal(result.action, "repair-official-ui");
  assert.deepEqual(delays, [5000]);
  assert.deepEqual(calls.filter((call) => Array.isArray(call) && call[0] === "showOfficialWindowTarget"), [
    ["showOfficialWindowTarget", "service-target", 9222],
  ]);
  assert.deepEqual(result.shownOfficialWindow, { ok: true, method: "SF.windowMgr.show", id: "0" });
  assert.equal(result.status.officialUi.needsNativeWindowRestore, false);

  calls.length = 0;
  delays.length = 0;
  showRequested = false;
  settled = false;
  shouldConverge = false;
  const failed = await service.repairOfficialUi(config);

  assert.equal(failed.action, "repair-official-ui-incomplete");
  assert.deepEqual(delays, [5000]);
  assert.deepEqual(calls.filter((call) => Array.isArray(call) && call[0] === "showOfficialWindowTarget"), [
    ["showOfficialWindowTarget", "service-target", 9222],
  ]);
  assert.equal(failed.status.officialUi.needsNativeWindowRestore, true);
  assert.equal(failed.safeFallback?.action, "skip-official-ui-login-fallback-disabled");
  assert.deepEqual(calls.filter((call) => Array.isArray(call) && call[0] === "navigateRemoteDebugTarget"), []);
});

test("VpnService.repairOfficialUi dismisses ecResize native alerts before reporting service UI consistency", async () => {
  const calls = [];
  let nativeWindowCalls = 0;
  const fakeRuntime = {
    async describeActiveSession() {
      return {
        token: "secret-token",
        sessionId: "session-1",
      };
    },
    async getLoginStatus() {
      return { status: "1" };
    },
    async getServiceState() {
      return { base: "18", l3vpn: "18", tcp: "43" };
    },
    async getLocalRuntimeInfo() {
      return { enableAutoLogin: 0 };
    },
    async getRemoteDebugTargets() {
      return [
        {
          id: "service-target",
          type: "page",
          title: "Loading...",
          url: "https://198.51.100.20:9898/portal/#!/service",
          webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/service-target",
        },
      ];
    },
    async evaluateOnRemoteDebugPageTarget(target) {
      return {
        evaluation: {
          result: {
            value: {
              href: target.url,
              title: target.title,
              visibilityState: "visible",
              hidden: false,
              bodyText: "资源搜索 默认资源组",
            },
          },
        },
      };
    },
    async getOfficialNativeWindowState() {
      nativeWindowCalls += 1;
      if (nativeWindowCalls === 1) {
        return {
          ok: true,
          visible: true,
          windowCount: 1,
          windowNames: ["Loading..."],
          alerts: [
            {
              text: "ecResize response data error, errorcode:0, errormsg:onResizeWindow failed, winID is not exist",
              buttons: ["OK"],
            },
          ],
        };
      }

      return { ok: true, visible: true, windowCount: 1, windowNames: ["EasyConnect"], alerts: [] };
    },
    async dismissOfficialNativeAlerts(alerts, options) {
      calls.push(["dismissOfficialNativeAlerts", alerts.map((alert) => alert.text), options.remoteDebugPort]);
      return {
        ok: true,
        dismissed: alerts.length,
      };
    },
    async getBundleSettingPath() {
      return "/Applications/EasyConnect.app/Contents/Resources/conf/setting_demo.json";
    },
    async getPort() {
      return 54530;
    },
    async describeLatestCachedToken() {
      return {};
    },
    async getGatewayCandidates() {
      return [];
    },
    async waitForRemoteDebugTarget(targetUrlPart, options) {
      calls.push(["waitForRemoteDebugTarget", targetUrlPart, options.remoteDebugPort]);
      return { id: "service-target", url: "https://198.51.100.20:9898/portal/#!/service" };
    },
    async syncPortalGlobalState(targetUrlPart, context, options) {
      calls.push(["syncPortalGlobalState", targetUrlPart, context.sessionId, options.profile]);
      return { ok: true };
    },
    async bootstrapViaPageBridge(targetUrlPart, context, options) {
      calls.push(["bootstrapViaPageBridge", targetUrlPart, context.sessionId, options.remoteDebugPort]);
      return { ok: true, token: "derived-token" };
    },
    async reloadPortalTarget(targetUrlPart, options) {
      calls.push(["reloadPortalTarget", targetUrlPart, options.remoteDebugPort]);
      return { ok: true, href: "https://198.51.100.20:9898/portal/#!/service" };
    },
    appExecutable: "/Applications/EasyConnect.app/Contents/MacOS/EasyConnect",
  };

  const service = new VpnService({
    runtimeFactory: () => fakeRuntime,
    existsFn: async () => true,
  });

  const result = await service.repairOfficialUi({
    vpn: {
      username: "demo-user",
      remoteDebugPort: 9222,
      gateways: [{ host: "198.51.100.20", port: 9898 }],
    },
  });

  assert.equal(result.action, "repair-official-ui");
  assert.deepEqual(calls.filter((call) => Array.isArray(call) && call[0] === "dismissOfficialNativeAlerts"), [
    [
      "dismissOfficialNativeAlerts",
      ["ecResize response data error, errorcode:0, errormsg:onResizeWindow failed, winID is not exist"],
      9222,
    ],
  ]);
  assert.deepEqual(result.dismissedNativeAlerts, { ok: true, dismissed: 1 });
  assert.equal(result.status.officialUi.hasBlockingNativeAlert, false);
});

test("VpnService.repairOfficialUi waits for stacked ecResize alerts to be fully dismissed", async () => {
  const calls = [];
  let nativeWindowCalls = 0;
  const fakeRuntime = {
    async describeActiveSession() {
      return {
        token: "secret-token",
        sessionId: "session-1",
      };
    },
    async getLoginStatus() {
      return { status: "1" };
    },
    async getServiceState() {
      return { base: "18", l3vpn: "18", tcp: "43" };
    },
    async getLocalRuntimeInfo() {
      return { enableAutoLogin: 0 };
    },
    async getRemoteDebugTargets() {
      return [
        {
          id: "service-target",
          type: "page",
          title: "EasyConnect",
          url: "https://198.51.100.20:9898/portal/#!/service",
          webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/service-target",
        },
      ];
    },
    async evaluateOnRemoteDebugPageTarget(target) {
      return {
        evaluation: {
          result: {
            value: {
              href: target.url,
              title: target.title,
              visibilityState: "visible",
              hidden: false,
              bodyText: "资源搜索 默认资源组",
            },
          },
        },
      };
    },
    async getOfficialNativeWindowState() {
      nativeWindowCalls += 1;
      if (nativeWindowCalls <= 2) {
        return {
          ok: true,
          visible: true,
          windowCount: 2,
          windowNames: ["EasyConnect", "EasyConnect"],
          alerts: [
            {
              text: "ecResize response data error, errorcode:0, errormsg:onResizeWindow failed, winID is not exist",
              buttons: ["OK"],
            },
          ],
        };
      }

      return { ok: true, visible: true, windowCount: 1, windowNames: ["EasyConnect"], alerts: [] };
    },
    async dismissOfficialNativeAlerts(alerts, options) {
      calls.push(["dismissOfficialNativeAlerts", alerts.length, options.remoteDebugPort]);
      return {
        ok: true,
        dismissed: 2,
        verified: true,
        finalState: { ok: true, visible: true, windowCount: 1, windowNames: ["EasyConnect"], alerts: [] },
      };
    },
    async closeExtraOfficialNativeWindows(options) {
      calls.push(["closeExtraOfficialNativeWindows", options.remoteDebugPort]);
      return {
        ok: true,
        beforeCount: 2,
        afterCount: 1,
        closed: 1,
        finalState: { ok: true, visible: true, windowCount: 1, windowNames: ["EasyConnect"], alerts: [] },
      };
    },
    async getBundleSettingPath() {
      return "/Applications/EasyConnect.app/Contents/Resources/conf/setting_demo.json";
    },
    async getPort() {
      return 54530;
    },
    async describeLatestCachedToken() {
      return {};
    },
    async getGatewayCandidates() {
      return [];
    },
    async waitForRemoteDebugTarget() {
      return { id: "service-target", url: "https://198.51.100.20:9898/portal/#!/service" };
    },
    async syncPortalGlobalState() {
      return { ok: true };
    },
    async bootstrapViaPageBridge() {
      return { ok: true, token: "derived-token" };
    },
    async reloadPortalTarget() {
      return { ok: true, href: "https://198.51.100.20:9898/portal/#!/service" };
    },
    appExecutable: "/Applications/EasyConnect.app/Contents/MacOS/EasyConnect",
  };

  const service = new VpnService({
    runtimeFactory: () => fakeRuntime,
    existsFn: async () => true,
  });

  const result = await service.repairOfficialUi({
    vpn: {
      username: "demo-user",
      remoteDebugPort: 9222,
      gateways: [{ host: "198.51.100.20", port: 9898 }],
    },
  });

  assert.equal(result.action, "repair-official-ui");
  assert.deepEqual(calls, [
    ["dismissOfficialNativeAlerts", 1, 9222],
    ["closeExtraOfficialNativeWindows", 9222],
  ]);
  assert.equal(result.dismissedNativeAlerts.dismissed, 2);
  assert.equal(result.status.officialUi.hasBlockingNativeAlert, false);
  assert.equal(result.status.officialUi.hasDuplicateNativeWindows, false);
});

test("VpnService.repairOfficialUi consolidates duplicate native EasyConnect windows", async () => {
  const calls = [];
  let nativeWindowCount = 3;
  const fakeRuntime = {
    async describeActiveSession() {
      return {
        token: "secret-token",
        sessionId: "session-1",
      };
    },
    async getLoginStatus() {
      return { status: "1" };
    },
    async getServiceState() {
      return { base: "18", l3vpn: "18", tcp: "43" };
    },
    async getLocalRuntimeInfo() {
      return { enableAutoLogin: 0 };
    },
    async getRemoteDebugTargets() {
      return [
        {
          id: "service-target",
          type: "page",
          title: "EasyConnect",
          url: "https://198.51.100.20:9898/portal/#!/service",
          webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/service-target",
        },
      ];
    },
    async evaluateOnRemoteDebugPageTarget(target) {
      return {
        evaluation: {
          result: {
            value: {
              href: target.url,
              title: target.title,
              visibilityState: "visible",
              hidden: false,
              bodyText: "资源搜索 默认资源组",
            },
          },
        },
      };
    },
    async getOfficialNativeWindowState() {
      return {
        ok: true,
        visible: true,
        windowCount: nativeWindowCount,
        windowNames: Array.from({ length: nativeWindowCount }, () => "EasyConnect"),
        alerts: [],
      };
    },
    async closeExtraOfficialNativeWindows(options) {
      calls.push(["closeExtraOfficialNativeWindows", options.remoteDebugPort]);
      nativeWindowCount = 1;
      return {
        ok: true,
        closed: 2,
        requestedWindowCount: 3,
        finalState: {
          ok: true,
          visible: true,
          windowCount: 1,
          windowNames: ["EasyConnect"],
          alerts: [],
        },
      };
    },
    async getBundleSettingPath() {
      return "/Applications/EasyConnect.app/Contents/Resources/conf/setting_demo.json";
    },
    async getPort() {
      return 54530;
    },
    async describeLatestCachedToken() {
      return {};
    },
    async getGatewayCandidates() {
      return [];
    },
    async waitForRemoteDebugTarget(targetUrlPart, options) {
      calls.push(["waitForRemoteDebugTarget", targetUrlPart, options.remoteDebugPort]);
      return { id: "service-target", url: "https://198.51.100.20:9898/portal/#!/service" };
    },
    async syncPortalGlobalState(targetUrlPart, context, options) {
      calls.push(["syncPortalGlobalState", targetUrlPart, context.sessionId, options.profile]);
      return { ok: true };
    },
    async bootstrapViaPageBridge(targetUrlPart, context, options) {
      calls.push(["bootstrapViaPageBridge", targetUrlPart, context.sessionId, options.remoteDebugPort]);
      return { ok: true, token: "derived-token" };
    },
    async reloadPortalTarget(targetUrlPart, options) {
      calls.push(["reloadPortalTarget", targetUrlPart, options.remoteDebugPort]);
      return { ok: true, href: "https://198.51.100.20:9898/portal/#!/service" };
    },
    appExecutable: "/Applications/EasyConnect.app/Contents/MacOS/EasyConnect",
  };

  const service = new VpnService({
    runtimeFactory: () => fakeRuntime,
    existsFn: async () => true,
  });

  const result = await service.repairOfficialUi({
    vpn: {
      username: "demo-user",
      remoteDebugPort: 9222,
      gateways: [{ host: "198.51.100.20", port: 9898 }],
    },
  });

  assert.equal(result.action, "repair-official-ui");
  assert.deepEqual(calls.filter((call) => Array.isArray(call) && call[0] === "closeExtraOfficialNativeWindows"), [
    ["closeExtraOfficialNativeWindows", 9222],
  ]);
  assert.equal(result.consolidatedNativeWindows.closed, 2);
  assert.equal(result.status.officialUi.hasDuplicateNativeWindows, false);
  assert.equal(result.status.officialUi.nativeWindowState.windowCount, 1);
});

test("VpnService.repairOfficialUi continues service restore when native alert dismissal exposes login page", async () => {
  const calls = [];
  let targetListCalls = 0;
  let nativeWindowCalls = 0;
  const fakeRuntime = {
    async describeActiveSession() {
      return {
        token: "secret-token",
        sessionId: "session-1",
      };
    },
    async getLoginStatus() {
      return { status: "1" };
    },
    async getServiceState() {
      return { base: "18", l3vpn: "18", tcp: "43" };
    },
    async getLocalRuntimeInfo() {
      return { enableAutoLogin: 0 };
    },
    async getRemoteDebugTargets() {
      targetListCalls += 1;
      if (targetListCalls === 1) {
        return [
          {
            id: "service-target",
            type: "page",
            title: "Loading...",
            url: "https://198.51.100.20:9898/portal/#!/service",
            webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/service-target",
          },
        ];
      }

      if (targetListCalls === 2) {
        return [
          {
            id: "login-target",
            type: "page",
            title: "EasyConnect",
            url: "https://198.51.100.20:9898/portal/#!/login",
            webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/login-target",
          },
        ];
      }

      return [
        {
          id: "service-target",
          type: "page",
          title: "EasyConnect",
          url: "https://198.51.100.20:9898/portal/#!/service",
          webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/service-target",
        },
      ];
    },
    async evaluateOnRemoteDebugPageTarget(target) {
      const isService = target.url.includes("/portal/#!/service");
      return {
        evaluation: {
          result: {
            value: {
              href: target.url,
              title: target.title,
              visibilityState: "visible",
              hidden: false,
              bodyText: isService ? "资源搜索 默认资源组" : "用户名 密码 登录",
            },
          },
        },
      };
    },
    async getOfficialNativeWindowState() {
      nativeWindowCalls += 1;
      if (nativeWindowCalls === 1) {
        return {
          ok: true,
          visible: true,
          windowCount: 1,
          windowNames: ["Loading..."],
          alerts: [
            {
              text: "ecResize response data error, errorcode:0, errormsg:onResizeWindow failed, winID is not exist",
              buttons: ["OK"],
            },
          ],
        };
      }

      return { ok: true, visible: true, windowCount: 1, windowNames: ["EasyConnect"], alerts: [] };
    },
    async dismissOfficialNativeAlerts(alerts, options) {
      calls.push(["dismissOfficialNativeAlerts", alerts.map((alert) => alert.text), options.remoteDebugPort]);
      return { ok: true, dismissed: alerts.length };
    },
    async getBundleSettingPath() {
      return "/Applications/EasyConnect.app/Contents/Resources/conf/setting_demo.json";
    },
    async getPort() {
      return 54530;
    },
    async describeLatestCachedToken() {
      return {};
    },
    async getGatewayCandidates() {
      return [];
    },
    async waitForRemoteDebugTarget(targetUrlPart, options) {
      calls.push(["waitForRemoteDebugTarget", targetUrlPart, options.remoteDebugPort]);
      return { id: "service-target", url: "https://198.51.100.20:9898/portal/#!/service" };
    },
    async syncPortalGlobalState(targetUrlPart, context, options) {
      calls.push(["syncPortalGlobalState", targetUrlPart, context.sessionId, options.profile]);
      return { ok: true };
    },
    async bootstrapViaPageBridge(targetUrlPart, context, options) {
      calls.push(["bootstrapViaPageBridge", targetUrlPart, context.sessionId, options.remoteDebugPort]);
      return { ok: false, reason: "SF bridge missing" };
    },
    async reloadPortalTarget(targetUrlPart, options) {
      calls.push(["reloadPortalTarget", targetUrlPart, options.remoteDebugPort]);
      return { ok: true, href: "https://198.51.100.20:9898/portal/#!/service" };
    },
    async navigateRemoteDebugTarget(targetId, targetUrl, options) {
      calls.push(["navigateRemoteDebugTarget", targetId, targetUrl, options.remoteDebugPort]);
      return { ok: true, requestedUrl: targetUrl };
    },
    appExecutable: "/Applications/EasyConnect.app/Contents/MacOS/EasyConnect",
  };

  const service = new VpnService({
    runtimeFactory: () => fakeRuntime,
    existsFn: async () => true,
  });

  const result = await service.repairOfficialUi({
    vpn: {
      username: "demo-user",
      remoteDebugPort: 9222,
      gateways: [{ host: "198.51.100.20", port: 9898 }],
    },
  });

  assert.equal(result.action, "repair-official-ui");
  assert.equal(result.retry.reason, "post-repair-official-ui-inconsistent");
  assert.equal(result.status.officialUi.primaryTarget.kind, "service");
  assert.deepEqual(calls.filter((call) => Array.isArray(call) && call[0] === "navigateRemoteDebugTarget"), [
    [
      "navigateRemoteDebugTarget",
      "login-target",
      "https://198.51.100.20:9898/portal/#!/service",
      9222,
    ],
  ]);
});

test("VpnService.repairOfficialUi closes user-setting helper targets after relogin recovery", async () => {
  const calls = [];
  let nativeWindowCount = 2;
  const fakeRuntime = {
    async describeActiveSession() {
      return {
        token: "secret-token",
        sessionId: "session-1",
      };
    },
    async getLoginStatus() {
      return { status: "1" };
    },
    async getServiceState() {
      return { base: "18", l3vpn: "18", tcp: "43" };
    },
    async getLocalRuntimeInfo() {
      return { enableAutoLogin: 0 };
    },
    async getRemoteDebugTargets() {
      return [
        {
          id: "user-setting-target",
          type: "page",
          title: "个人设置",
          url: "https://198.51.100.20:9898/portal/#!/user_setting_box",
          webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/user-setting-target",
        },
        {
          id: "service-target",
          type: "page",
          title: "EasyConnect",
          url: "https://198.51.100.20:9898/portal/#!/service",
          webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/service-target",
        },
      ];
    },
    async evaluateOnRemoteDebugPageTarget(target) {
      return {
        evaluation: {
          result: {
            value: {
              href: target.url,
              title: target.title,
              visibilityState: "visible",
              hidden: false,
              bodyText: target.id === "service-target" ? "资源搜索 默认资源组" : "个人设置 修改密码 登录设备",
            },
          },
        },
      };
    },
    async getBundleSettingPath() {
      return "/Applications/EasyConnect.app/Contents/Resources/conf/setting_demo.json";
    },
    async getPort() {
      return 54530;
    },
    async describeLatestCachedToken() {
      return {};
    },
    async getGatewayCandidates() {
      return [];
    },
    async waitForRemoteDebugTarget(targetUrlPart, options) {
      calls.push(["waitForRemoteDebugTarget", targetUrlPart, options.remoteDebugPort]);
      return { id: "service-target", url: "https://198.51.100.20:9898/portal/#!/service" };
    },
    async syncPortalGlobalState(targetUrlPart, context, options) {
      calls.push(["syncPortalGlobalState", targetUrlPart, context.sessionId, context.gatewayHost, context.gatewayPort, options.profile]);
      return { ok: true };
    },
    async bootstrapViaPageBridge(targetUrlPart, context, options) {
      calls.push(["bootstrapViaPageBridge", targetUrlPart, context.sessionId, options.remoteDebugPort]);
      return { ok: true, token: "derived-token" };
    },
    async reloadPortalTarget(targetUrlPart, options) {
      calls.push(["reloadPortalTarget", targetUrlPart, options.remoteDebugPort]);
      return { ok: true, href: "https://198.51.100.20:9898/portal/#!/service" };
    },
    async closeOfficialWindowTarget(targetUrlPart, options) {
      calls.push(["closeOfficialWindowTarget", targetUrlPart, options.remoteDebugPort]);
      nativeWindowCount = 1;
      return { ok: true, closedBy: "official-window-api" };
    },
    async getOfficialNativeWindowState() {
      return {
        ok: true,
        visible: true,
        windowCount: nativeWindowCount,
        windowNames: Array.from({ length: nativeWindowCount }, () => "EasyConnect"),
      };
    },
    appExecutable: "/Applications/EasyConnect.app/Contents/MacOS/EasyConnect",
  };

  const service = new VpnService({
    runtimeFactory: () => fakeRuntime,
    existsFn: async () => true,
  });

  const result = await service.repairOfficialUi(
    {
      vpn: {
        username: "demo-user",
        remoteDebugPort: 9222,
        gateways: [{ host: "198.51.100.20", port: 9898 }],
      },
    },
    { onlineAction: "relogin-page-bridge" },
  );

  assert.equal(result.action, "repair-official-ui");
  assert.deepEqual(calls.filter((call) => Array.isArray(call) && call[0] === "closeOfficialWindowTarget"), [
    ["closeOfficialWindowTarget", "user-setting-target", 9222],
  ]);
  assert.deepEqual(result.closedResidualTargets.map((target) => [target.id, target.kind, target.originalKind]), [
    ["user-setting-target", "user-setting", undefined],
  ]);
  assert.equal(result.status.officialUi.nativeWindowState.windowCount, 1);
});

test("VpnService.repairOfficialUi closes a stale login target when service already exists", async () => {
  const calls = [];
  let nativeWindowCount = 2;
  const fakeRuntime = {
    async describeActiveSession() {
      return {
        token: "secret-token",
        sessionId: "session-1",
      };
    },
    async getLoginStatus() {
      return { status: "1" };
    },
    async getServiceState() {
      return { base: "18", l3vpn: "18", tcp: "43" };
    },
    async getLocalRuntimeInfo() {
      return { enableAutoLogin: 0 };
    },
    async getRemoteDebugTargets() {
      return [
        {
          id: "login-stale",
          type: "page",
          title: "EasyConnect",
          url: "https://198.51.100.20:9898/portal/#!/login",
          webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/login-stale",
        },
        {
          id: "service-target",
          type: "page",
          title: "EasyConnect",
          url: "https://198.51.100.20:9898/portal/#!/service",
          webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/service-target",
        },
      ];
    },
    async evaluateOnRemoteDebugPageTarget(target) {
      return {
        evaluation: {
          result: {
            value: {
              href: target.url,
              title: target.title,
              visibilityState: "hidden",
              hidden: true,
              bodyText: target.id === "service-target" ? "资源搜索 默认资源组" : "用户名 密码 登录",
            },
          },
        },
      };
    },
    async getBundleSettingPath() {
      return "/Applications/EasyConnect.app/Contents/Resources/conf/setting_demo.json";
    },
    async getPort() {
      return 54530;
    },
    async describeLatestCachedToken() {
      return {};
    },
    async getGatewayCandidates() {
      return [];
    },
    async waitForRemoteDebugTarget(targetUrlPart, options) {
      calls.push(["waitForRemoteDebugTarget", targetUrlPart, options.remoteDebugPort]);
      return { id: "service-target", url: "https://198.51.100.20:9898/portal/#!/service" };
    },
    async syncPortalGlobalState(targetUrlPart, context, options) {
      calls.push(["syncPortalGlobalState", targetUrlPart, context.sessionId, context.gatewayHost, context.gatewayPort, options.profile]);
      return { ok: true };
    },
    async bootstrapViaPageBridge(targetUrlPart, context, options) {
      calls.push(["bootstrapViaPageBridge", targetUrlPart, context.sessionId, options.remoteDebugPort]);
      return { ok: true, token: "derived-token" };
    },
    async reloadPortalTarget(targetUrlPart, options) {
      calls.push(["reloadPortalTarget", targetUrlPart, options.remoteDebugPort]);
      return { ok: true, href: "https://198.51.100.20:9898/portal/#!/service" };
    },
    async closeOfficialWindowTarget(targetUrlPart, options) {
      calls.push(["closeOfficialWindowTarget", targetUrlPart, options.remoteDebugPort]);
      nativeWindowCount = 1;
      return { ok: true, closedBy: "official-window-api" };
    },
    async getOfficialNativeWindowState() {
      return {
        ok: true,
        visible: true,
        windowCount: nativeWindowCount,
        windowNames: Array.from({ length: nativeWindowCount }, () => "EasyConnect"),
      };
    },
    appExecutable: "/Applications/EasyConnect.app/Contents/MacOS/EasyConnect",
  };

  const service = new VpnService({
    runtimeFactory: () => fakeRuntime,
    existsFn: async () => true,
  });

  const result = await service.repairOfficialUi({
    vpn: {
      username: "demo-user",
      remoteDebugPort: 9222,
      gateways: [{ host: "198.51.100.20", port: 9898 }],
    },
  });

  assert.equal(result.action, "repair-official-ui");
  assert.deepEqual(calls.filter((call) => Array.isArray(call) && call[0] === "closeOfficialWindowTarget"), [
    ["closeOfficialWindowTarget", "login-stale", 9222],
  ]);
  assert.deepEqual(result.closedResidualTargets.map((target) => [target.id, target.kind]), [
    ["login-stale", "login"],
  ]);
  assert.equal(result.status.officialUi.nativeWindowState.windowCount, 1);
});

test("VpnService.repairOfficialUi keeps the relogin bridge target and closes the old service target", async () => {
  const calls = [];
  let nativeWindowCount = 2;
  const fakeRuntime = {
    async describeActiveSession() {
      return {
        token: "secret-token",
        sessionId: "session-1",
      };
    },
    async getLoginStatus() {
      return { status: "1" };
    },
    async getServiceState() {
      return { base: "18", l3vpn: "18", tcp: "43" };
    },
    async getLocalRuntimeInfo() {
      return { enableAutoLogin: 0 };
    },
    async getOfficialNativeWindowState() {
      return {
        ok: true,
        visible: true,
        windowCount: nativeWindowCount,
        windowNames: Array.from({ length: nativeWindowCount }, () => "EasyConnect"),
      };
    },
    async getRemoteDebugTargets() {
      return [
        {
          id: "login-bridge",
          type: "page",
          title: "EasyConnect",
          url: "https://198.51.100.20:9898/portal/#!/login",
          webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/login-bridge",
        },
        {
          id: "old-service",
          type: "page",
          title: "EasyConnect",
          url: "https://198.51.100.20:9898/portal/#!/service",
          webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/old-service",
        },
      ];
    },
    async evaluateOnRemoteDebugPageTarget(target) {
      return {
        evaluation: {
          result: {
            value: {
              href: target.url,
              title: target.title,
              visibilityState: "hidden",
              hidden: true,
              bodyText: target.id === "old-service" ? "资源搜索 默认资源组" : "用户名 密码 登录",
            },
          },
        },
      };
    },
    async getBundleSettingPath() {
      return "/Applications/EasyConnect.app/Contents/Resources/conf/setting_demo.json";
    },
    async getPort() {
      return 54530;
    },
    async describeLatestCachedToken() {
      return {};
    },
    async getGatewayCandidates() {
      return [];
    },
    async waitForRemoteDebugTarget(targetUrlPart, options) {
      calls.push(["waitForRemoteDebugTarget", targetUrlPart, options.remoteDebugPort]);
      return { id: "old-service", url: "https://198.51.100.20:9898/portal/#!/service" };
    },
    async syncPortalGlobalState(targetUrlPart, context, options) {
      calls.push(["syncPortalGlobalState", targetUrlPart, context.sessionId, context.gatewayHost, context.gatewayPort, options.profile]);
      return { ok: true };
    },
    async bootstrapViaPageBridge(targetUrlPart, context, options) {
      calls.push(["bootstrapViaPageBridge", targetUrlPart, context.sessionId, options.remoteDebugPort]);
      return { ok: true, token: "derived-token" };
    },
    async reloadPortalTarget(targetUrlPart, options) {
      calls.push(["reloadPortalTarget", targetUrlPart, options.remoteDebugPort]);
      return { ok: true, href: "https://198.51.100.20:9898/portal/#!/service" };
    },
    async closeOfficialWindowTarget(targetUrlPart, options) {
      calls.push(["closeOfficialWindowTarget", targetUrlPart, options.remoteDebugPort]);
      nativeWindowCount = 1;
      return { ok: true, closedBy: "official-window-api" };
    },
    appExecutable: "/Applications/EasyConnect.app/Contents/MacOS/EasyConnect",
  };

  const service = new VpnService({
    runtimeFactory: () => fakeRuntime,
    existsFn: async () => true,
  });

  const result = await service.repairOfficialUi(
    {
      vpn: {
        username: "demo-user",
        remoteDebugPort: 9222,
        gateways: [{ host: "198.51.100.20", port: 9898 }],
      },
    },
    { onlineAction: "relogin-page-bridge" },
  );

  assert.equal(result.action, "repair-official-ui");
  assert.deepEqual(calls.filter((call) => Array.isArray(call) && call[0] === "closeOfficialWindowTarget"), [
    ["closeOfficialWindowTarget", "old-service", 9222],
  ]);
  assert.deepEqual(result.closedResidualTargets.map((target) => [target.id, target.kind, target.originalKind]), [
    ["old-service", "pre-relogin-service", "service"],
  ]);
  assert.equal(result.status.officialUi.nativeWindowState.windowCount, 1);
});

test("VpnService.repairOfficialUi uses target ids after sanitizing connect_notfound URLs", async () => {
  const calls = [];
  let notfoundClosed = false;
  const notfoundUrl =
    "file:///Applications/EasyConnect.app/Contents/Resources/Web/local/connect_notfound/connect_notfound.html?from=https%3A%2F%2F198.51.100.20%3A9898%2Fportal%2Fshortcut.html%3Ftwfid%3D0123456789abcdef0123456789abcdef%26url%3D%252Fportal%252F%2523!%252Fuser_setting_box%26lang%3Dzh_CN";
  const fakeRuntime = {
    async describeActiveSession() {
      return {
        token: "secret-token",
        sessionId: "session-1",
      };
    },
    async getLoginStatus() {
      return { status: "1" };
    },
    async getServiceState() {
      return { base: "18", l3vpn: "18", tcp: "43" };
    },
    async getLocalRuntimeInfo() {
      return { enableAutoLogin: 0 };
    },
    async getRemoteDebugTargets() {
      return [
        {
          id: "service-target",
          type: "page",
          title: "EasyConnect",
          url: "https://198.51.100.20:9898/portal/#!/service",
          webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/service-target",
        },
        ...(
          notfoundClosed
            ? []
            : [
                {
                  id: "notfound-target",
                  type: "page",
                  title: "EasyConnect",
                  url: notfoundUrl,
                  webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/notfound-target",
                },
              ]
        ),
      ];
    },
    async evaluateOnRemoteDebugPageTarget(target) {
      return {
        evaluation: {
          result: {
            value: {
              href: target.url,
              title: target.title,
              visibilityState: "visible",
              hidden: false,
              bodyText: target.id === "notfound-target" ? "连接失败 请尝试刷新后重试" : "资源搜索 默认资源组",
            },
          },
        },
      };
    },
    async getBundleSettingPath() {
      return "/Applications/EasyConnect.app/Contents/Resources/conf/setting_demo.json";
    },
    async getPort() {
      return 54530;
    },
    async describeLatestCachedToken() {
      return {};
    },
    async getGatewayCandidates() {
      return [];
    },
    async waitForRemoteDebugTarget(targetUrlPart, options) {
      calls.push(["waitForRemoteDebugTarget", targetUrlPart, options.remoteDebugPort]);
      return { id: "service-target", url: "https://198.51.100.20:9898/portal/#!/service" };
    },
    async syncPortalGlobalState(targetUrlPart, context, options) {
      calls.push(["syncPortalGlobalState", targetUrlPart, context.sessionId, context.gatewayHost, context.gatewayPort, options.profile]);
      return { ok: true };
    },
    async bootstrapViaPageBridge(targetUrlPart, context, options) {
      calls.push(["bootstrapViaPageBridge", targetUrlPart, context.sessionId, options.remoteDebugPort]);
      return { ok: true, token: "derived-token" };
    },
    async reloadPortalTarget(targetUrlPart, options) {
      calls.push(["reloadPortalTarget", targetUrlPart, options.remoteDebugPort]);
      return { ok: true, href: "https://198.51.100.20:9898/portal/#!/service" };
    },
    async navigateRemoteDebugTarget(targetUrlPart, targetUrl, options) {
      calls.push(["navigateRemoteDebugTarget", targetUrlPart, targetUrl, options.remoteDebugPort]);
      return { ok: true, requestedUrl: targetUrl };
    },
    async closeOfficialWindowTarget(targetUrlPart, options) {
      calls.push(["closeOfficialWindowTarget", targetUrlPart, options.remoteDebugPort]);
      if (targetUrlPart === "notfound-target") {
        notfoundClosed = true;
      }
      return {
        ok: true,
        target: {
          id: "notfound-target",
          url: notfoundUrl,
        },
      };
    },
    async bringRemoteDebugTargetToFront(targetUrlPart, options) {
      calls.push(["bringRemoteDebugTargetToFront", targetUrlPart, options.remoteDebugPort]);
      return { ok: true, targetUrlPart };
    },
    appExecutable: "/Applications/EasyConnect.app/Contents/MacOS/EasyConnect",
  };

  const service = new VpnService({
    runtimeFactory: () => fakeRuntime,
    existsFn: async () => true,
  });

  const result = await service.repairOfficialUi({
    vpn: {
      username: "demo-user",
      remoteDebugPort: 9222,
      gateways: [{ host: "198.51.100.20", port: 9898 }],
    },
  });

  assert.equal(result.action, "repair-official-ui");
  assert.deepEqual(calls.filter((call) => Array.isArray(call) && call[0] === "closeOfficialWindowTarget"), [
    ["closeOfficialWindowTarget", "notfound-target", 9222],
  ]);
  assert.equal(result.closedResidualTargets[0].url.includes("0123456789abcdef"), false);
  assert.equal(result.closedResidualTargets[0].result.target.url.includes("0123456789abcdef"), false);
});

test("VpnService.repairOfficialUi treats status windows as consistent when the tunnel has a service target", async () => {
  const calls = [];
  const fakeRuntime = {
    async describeActiveSession() {
      return {
        token: "secret-token",
        sessionId: "session-1",
      };
    },
    async getLoginStatus() {
      return { status: "1" };
    },
    async getServiceState() {
      return { base: "18", l3vpn: "18", tcp: "43" };
    },
    async getLocalRuntimeInfo() {
      return { enableAutoLogin: 0 };
    },
    async getRemoteDebugTargets() {
      return [
        {
          id: "service-target",
          type: "page",
          title: "EasyConnect",
          url: "https://198.51.100.20:9898/portal/#!/service",
          webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/service-target",
        },
        {
          id: "status-target",
          type: "page",
          title: "EasyConnect",
          url: "file:///Applications/EasyConnect.app/Contents/Resources/Web/local/vpn_status_manager/vpn_status_manager.html",
          webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/status-target",
        },
      ];
    },
    async evaluateOnRemoteDebugPageTarget(target) {
      return {
        evaluation: {
          result: {
            value: {
              href: target.url,
              title: target.title,
              visibilityState: target.id === "status-target" ? "visible" : "hidden",
              hidden: target.id !== "status-target",
              bodyText: target.id === "service-target" ? "资源搜索 默认资源组" : "",
            },
          },
        },
      };
    },
    async getBundleSettingPath() {
      return "/Applications/EasyConnect.app/Contents/Resources/conf/setting_demo.json";
    },
    async getPort() {
      return 54530;
    },
    async describeLatestCachedToken() {
      return {};
    },
    async getGatewayCandidates() {
      return [];
    },
    async navigatePortalRoute(targetUrlPart, targetUrl, options) {
      calls.push(["navigatePortalRoute", targetUrlPart, targetUrl, options.remoteDebugPort]);
      return { ok: true, href: targetUrl };
    },
    async waitForRemoteDebugTarget(targetUrlPart, options) {
      calls.push(["waitForRemoteDebugTarget", targetUrlPart, options.remoteDebugPort]);
      return { id: "service-target", url: "https://198.51.100.20:9898/portal/#!/service" };
    },
    async syncPortalGlobalState(targetUrlPart, context, options) {
      calls.push(["syncPortalGlobalState", targetUrlPart, context.sessionId, context.gatewayHost, context.gatewayPort, options.profile]);
      return { ok: true };
    },
    async bootstrapViaPageBridge(targetUrlPart, context, options) {
      calls.push(["bootstrapViaPageBridge", targetUrlPart, context.sessionId, options.remoteDebugPort]);
      return { ok: true, token: "derived-token" };
    },
    async reloadPortalTarget(targetUrlPart, options) {
      calls.push(["reloadPortalTarget", targetUrlPart, options.remoteDebugPort]);
      return { ok: true, href: "https://198.51.100.20:9898/portal/#!/service" };
    },
    async navigateRemoteDebugTarget(targetUrlPart, targetUrl, options) {
      calls.push(["navigateRemoteDebugTarget", targetUrlPart, targetUrl, options.remoteDebugPort]);
      return { ok: true, requestedUrl: targetUrl };
    },
    appExecutable: "/Applications/EasyConnect.app/Contents/MacOS/EasyConnect",
  };

  const service = new VpnService({
    runtimeFactory: () => fakeRuntime,
    existsFn: async () => true,
  });

  const result = await service.repairOfficialUi({
    vpn: {
      username: "demo-user",
      remoteDebugPort: 9222,
      gateways: [{ host: "198.51.100.20", port: 9898 }],
    },
  });

  assert.equal(result.action, "already-consistent");
  assert.deepEqual(calls.filter((call) => Array.isArray(call) && call[0] === "navigateRemoteDebugTarget"), []);
});

test("VpnService.repairOfficialUi can reuse a verified online status when the fresh snapshot lags", async () => {
  const calls = [];
  let targetRestored = false;
  const serviceTarget = {
    id: "service-target",
    type: "page",
    title: "EasyConnect",
    url: "https://198.51.100.20:9898/portal/#!/service",
    webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/service-target",
  };
  const fakeRuntime = {
    async describeActiveSession() {
      return null;
    },
    async getLoginStatus() {
      return null;
    },
    async getServiceState() {
      return null;
    },
    async getLocalRuntimeInfo() {
      return null;
    },
    async getRemoteDebugTargets() {
      if (targetRestored) {
        return [serviceTarget];
      }

      return [
        {
          id: "connect-target",
          type: "page",
          title: "EasyConnect",
          url: "file:///Applications/EasyConnect.app/Contents/Resources/Web/local/connect/connect.html",
          webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/connect-target",
        },
        serviceTarget,
      ];
    },
    async evaluateOnRemoteDebugPageTarget(target) {
      if (target.id === "connect-target") {
        return {
          evaluation: {
            result: {
              value: {
                href: "file:///Applications/EasyConnect.app/Contents/Resources/Web/local/connect/connect.html",
                title: "EasyConnect",
                visibilityState: "visible",
                hidden: false,
                bodyText: "无法连接",
              },
            },
          },
        };
      }

      return {
        evaluation: {
          result: {
              value: {
                href: "https://198.51.100.20:9898/portal/#!/service",
                title: "EasyConnect",
                visibilityState: targetRestored ? "visible" : "hidden",
                hidden: !targetRestored,
                bodyText: "资源搜索 默认资源组",
            },
          },
        },
      };
    },
    async getBundleSettingPath() {
      return "/Applications/EasyConnect.app/Contents/Resources/conf/setting_demo.json";
    },
    async getPort() {
      return 54530;
    },
    async describeLatestCachedToken() {
      return {};
    },
    async getGatewayCandidates() {
      return [];
    },
    async navigatePortalRoute(targetUrlPart, targetUrl, options) {
      calls.push(["navigatePortalRoute", targetUrlPart, targetUrl, options.remoteDebugPort]);
      return { ok: true, href: targetUrl };
    },
    async waitForRemoteDebugTarget(targetUrlPart, options) {
      calls.push(["waitForRemoteDebugTarget", targetUrlPart, options.remoteDebugPort]);
      return { id: "service-target", url: "https://198.51.100.20:9898/portal/#!/service" };
    },
    async syncPortalGlobalState(targetUrlPart, context, options) {
      calls.push(["syncPortalGlobalState", targetUrlPart, context.sessionId, context.gatewayHost, context.gatewayPort, options.profile]);
      return { ok: true };
    },
    async bootstrapViaPageBridge(targetUrlPart, context, options) {
      calls.push(["bootstrapViaPageBridge", targetUrlPart, context.sessionId, options.remoteDebugPort]);
      return { ok: true, token: "derived-token" };
    },
    async reloadPortalTarget(targetUrlPart, options) {
      calls.push(["reloadPortalTarget", targetUrlPart, options.remoteDebugPort]);
      return { ok: true, href: "https://198.51.100.20:9898/portal/#!/service" };
    },
    async navigateRemoteDebugTarget(targetUrlPart, targetUrl, options) {
      calls.push(["navigateRemoteDebugTarget", targetUrlPart, targetUrl, options.remoteDebugPort]);
      targetRestored = true;
      return { ok: true, requestedUrl: targetUrl };
    },
    appExecutable: "/Applications/EasyConnect.app/Contents/MacOS/EasyConnect",
  };

  const service = new VpnService({
    runtimeFactory: () => fakeRuntime,
    ensureOnlineFn: async () => {
      throw new Error("repairOfficialUi should not call ensureOnline");
    },
    gatewayLoginFactory: () => {
      throw new Error("repairOfficialUi should not create gateway login");
    },
    existsFn: async () => true,
  });

  const result = await service.repairOfficialUi(
    {
      vpn: {
        username: "demo-user",
        remoteDebugPort: 9222,
        gateways: [{ host: "198.51.100.20", port: 9898 }],
      },
    },
    {
      knownOnlineStatus: {
        activeSession: {
          sessionId: "session-1",
          token: "secret-session-token",
        },
        loginStatus: {
          status: "1",
        },
        serviceState: {
          base: "18",
          l3vpn: "18",
          tcp: "43",
        },
      },
    },
  );

  assert.equal(result.action, "restore-hidden-service-target");
  assert.deepEqual(calls.filter((call) => Array.isArray(call)).map((call) => call[0]), [
    "navigateRemoteDebugTarget",
    "waitForRemoteDebugTarget",
    "syncPortalGlobalState",
    "bootstrapViaPageBridge",
    "reloadPortalTarget",
    "waitForRemoteDebugTarget",
    "waitForRemoteDebugTarget",
  ]);
});

test("VpnService.prepareOfficialUiRepairSmokeTarget reuses an existing connect target", async () => {
  const calls = [];
  const target = {
    id: "existing-connect-target",
    type: "page",
    title: "EasyConnect",
    url: "file:///Applications/EasyConnect.app/Contents/Resources/Web/local/connect/connect.html",
    webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/existing-connect-target",
  };
  const fakeRuntime = {
    appExecutable: "/Applications/EasyConnect.app/Contents/MacOS/EasyConnect",
    async getRemoteDebugTargets() {
      calls.push("getRemoteDebugTargets");
      return [target];
    },
    async evaluateOnRemoteDebugPageTarget() {
      return {
        evaluation: {
          result: {
            value: {
              href: target.url,
              title: target.title,
              visibilityState: "visible",
              hidden: false,
              bodyText: "",
            },
          },
        },
      };
    },
    async createRemoteDebugTarget() {
      calls.push("createRemoteDebugTarget");
      throw new Error("must not create a second connect target");
    },
  };
  const service = new VpnService({ runtimeFactory: () => fakeRuntime });

  const result = await service.prepareOfficialUiRepairSmokeTarget({
    vpn: { remoteDebugPort: 9333 },
  });

  assert.equal(result.action, "prepared-test-target");
  assert.equal(result.target.id, target.id);
  assert.equal(result.reusedExistingTarget, true);
  assert.equal(calls.includes("createRemoteDebugTarget"), false);
});

test("VpnService.prepareOfficialUiRepairSmokeTarget recognizes a target created despite HTTP 500", async () => {
  const calls = [];
  let targetCreated = false;
  const target = {
    id: "partially-created-target",
    type: "page",
    title: "EasyConnect",
    url: "file:///Applications/EasyConnect.app/Contents/Resources/Web/local/connect/connect.html",
    webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/partially-created-target",
  };
  const fakeRuntime = {
    appExecutable: "/Applications/EasyConnect.app/Contents/MacOS/EasyConnect",
    async getRemoteDebugTargets() {
      calls.push("getRemoteDebugTargets");
      return targetCreated ? [target] : [];
    },
    async evaluateOnRemoteDebugPageTarget() {
      return {
        evaluation: {
          result: {
            value: {
              href: target.url,
              title: target.title,
              visibilityState: "visible",
              hidden: false,
              bodyText: "",
            },
          },
        },
      };
    },
    async createRemoteDebugTarget(targetUrl, options) {
      calls.push(["createRemoteDebugTarget", targetUrl, options.remoteDebugPort]);
      targetCreated = true;
      throw new Error("HTTP 500: Could not create new page");
    },
  };
  const service = new VpnService({ runtimeFactory: () => fakeRuntime });

  const result = await service.prepareOfficialUiRepairSmokeTarget({
    vpn: { remoteDebugPort: 9333 },
  });

  assert.equal(result.action, "prepared-test-target");
  assert.equal(result.target.id, target.id);
  assert.match(result.prepareReason, /HTTP 500/);
  assert.equal(result.reusedExistingTarget, false);
  assert.equal(calls.filter((call) => call === "getRemoteDebugTargets").length, 2);
});

test("VpnService.prepareOfficialUiRepairSmokeTarget opens an isolated connect page target", async () => {
  const calls = [];
  const fakeRuntime = {
    appExecutable: "/Applications/EasyConnect.app/Contents/MacOS/EasyConnect",
    async createRemoteDebugTarget(targetUrl, options) {
      calls.push(["createRemoteDebugTarget", targetUrl, options.remoteDebugPort]);
      return {
        id: "smoke-target",
        type: "page",
        url: targetUrl,
      };
    },
  };

  const service = new VpnService({
    runtimeFactory: () => fakeRuntime,
  });

  const result = await service.prepareOfficialUiRepairSmokeTarget({
    vpn: {
      remoteDebugPort: 9333,
    },
  });

  assert.equal(result.action, "prepared-test-target");
  assert.equal(
    result.targetUrl,
    "file:///Applications/EasyConnect.app/Contents/Resources/Web/local/connect/connect.html",
  );
  assert.deepEqual(calls, [
    [
      "createRemoteDebugTarget",
      "file:///Applications/EasyConnect.app/Contents/Resources/Web/local/connect/connect.html",
      9333,
    ],
  ]);
});

test("VpnService.prepareOfficialUiRepairSmokeTarget skips when DevTools cannot create a target", async () => {
  const service = new VpnService({
    runtimeFactory: () => ({
      appExecutable: "/Applications/EasyConnect.app/Contents/MacOS/EasyConnect",
    }),
  });

  const result = await service.prepareOfficialUiRepairSmokeTarget({
    vpn: {
      remoteDebugPort: 9333,
    },
  });

  assert.equal(result.action, "skip-no-test-target");
  assert.match(result.reason, /not available/i);
});

test("VpnService.prepareOfficialUiRepairSmokeTarget can use a controlled service-target mutation", async () => {
  const calls = [];
  const fakeRuntime = {
    appExecutable: "/Applications/EasyConnect.app/Contents/MacOS/EasyConnect",
    async createRemoteDebugTarget(targetUrl, options) {
      calls.push(["createRemoteDebugTarget", targetUrl, options.remoteDebugPort]);
      throw new Error("HTTP 500: Could not create new page");
    },
    async navigatePortalRoute(targetUrlPart, targetUrl, options) {
      calls.push(["navigatePortalRoute", targetUrlPart, targetUrl, options.remoteDebugPort]);
      return {
        ok: true,
        href: targetUrl,
      };
    },
    async waitForRemoteDebugTarget(targetUrlPart, options) {
      calls.push(["waitForRemoteDebugTarget", targetUrlPart, options.remoteDebugPort]);
      return {
        id: "mutated-service-target",
        url: "file:///Applications/EasyConnect.app/Contents/Resources/Web/local/connect/connect.html",
      };
    },
  };

  const service = new VpnService({
    runtimeFactory: () => fakeRuntime,
  });

  const result = await service.prepareOfficialUiRepairSmokeTarget(
    {
      vpn: {
        remoteDebugPort: 9333,
      },
    },
    {
      allowServiceTargetMutation: true,
    },
  );

  assert.equal(result.action, "prepared-by-mutating-service-target");
  assert.equal(
    result.targetUrl,
    "file:///Applications/EasyConnect.app/Contents/Resources/Web/local/connect/connect.html",
  );
  assert.deepEqual(calls, [
    [
      "createRemoteDebugTarget",
      "file:///Applications/EasyConnect.app/Contents/Resources/Web/local/connect/connect.html",
      9333,
    ],
    [
      "navigatePortalRoute",
      "/portal/#!/service",
      "file:///Applications/EasyConnect.app/Contents/Resources/Web/local/connect/connect.html",
      9333,
    ],
    ["waitForRemoteDebugTarget", "/local/connect/connect.html", 9333],
  ]);
});

test("VpnService.prepareOfficialUiRepairSmokeTarget mutates a visible non-service target before a hidden service target", async () => {
  const calls = [];
  const fakeRuntime = {
    appExecutable: "/Applications/EasyConnect.app/Contents/MacOS/EasyConnect",
    async createRemoteDebugTarget(targetUrl, options) {
      calls.push(["createRemoteDebugTarget", targetUrl, options.remoteDebugPort]);
      throw new Error("HTTP 500: Could not create new page");
    },
    async getRemoteDebugTargets() {
      calls.push("getRemoteDebugTargets");
      return [
        {
          id: "service-target",
          type: "page",
          title: "EasyConnect",
          url: "https://198.51.100.20:9898/portal/#!/service",
          webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/service-target",
        },
        {
          id: "setting-target",
          type: "page",
          title: "个人设置",
          url: "https://198.51.100.20:9898/portal/#!/user_setting_box",
          webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/setting-target",
        },
      ];
    },
    async evaluateOnRemoteDebugPageTarget(target) {
      calls.push(["evaluateOnRemoteDebugPageTarget", target.id]);
      return {
        evaluation: {
          result: {
            value: {
              href: target.url,
              title: target.title,
              visibilityState: target.id === "setting-target" ? "visible" : "hidden",
              hidden: target.id !== "setting-target",
              bodyText: target.id === "setting-target" ? "个人设置" : "资源搜索 默认资源组",
            },
          },
        },
      };
    },
    async navigatePortalRoute(targetUrlPart, targetUrl, options) {
      calls.push(["navigatePortalRoute", targetUrlPart, targetUrl, options.remoteDebugPort]);
      return {
        ok: true,
        href: targetUrl,
      };
    },
    async waitForRemoteDebugTarget(targetUrlPart, options) {
      calls.push(["waitForRemoteDebugTarget", targetUrlPart, options.remoteDebugPort]);
      return {
        id: "setting-target",
        url: "file:///Applications/EasyConnect.app/Contents/Resources/Web/local/connect/connect.html",
      };
    },
  };

  const service = new VpnService({
    runtimeFactory: () => fakeRuntime,
  });

  const result = await service.prepareOfficialUiRepairSmokeTarget(
    {
      vpn: {
        remoteDebugPort: 9333,
      },
    },
    {
      allowServiceTargetMutation: true,
    },
  );

  assert.equal(result.action, "prepared-by-mutating-service-target");
  assert.deepEqual(calls.filter((call) => Array.isArray(call) && call[0] === "navigatePortalRoute"), [
    [
      "navigatePortalRoute",
      "/portal/#!/user_setting_box",
      "file:///Applications/EasyConnect.app/Contents/Resources/Web/local/connect/connect.html",
      9333,
    ],
  ]);
});

test("VpnService.prepareOfficialUiRepairSmokeTarget prefers DevTools navigation over page JavaScript navigation", async () => {
  const calls = [];
  const fakeRuntime = {
    appExecutable: "/Applications/EasyConnect.app/Contents/MacOS/EasyConnect",
    async createRemoteDebugTarget(targetUrl, options) {
      calls.push(["createRemoteDebugTarget", targetUrl, options.remoteDebugPort]);
      throw new Error("HTTP 500: Could not create new page");
    },
    async getRemoteDebugTargets() {
      calls.push("getRemoteDebugTargets");
      return [
        {
          id: "setting-target",
          type: "page",
          title: "个人设置",
          url: "https://198.51.100.20:9898/portal/#!/user_setting_box",
          webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/setting-target",
        },
      ];
    },
    async evaluateOnRemoteDebugPageTarget(target) {
      calls.push(["evaluateOnRemoteDebugPageTarget", target.id]);
      return {
        evaluation: {
          result: {
            value: {
              href: target.url,
              title: target.title,
              visibilityState: "visible",
              hidden: false,
              bodyText: "个人设置",
            },
          },
        },
      };
    },
    async navigateRemoteDebugTarget(targetUrlPart, targetUrl, options) {
      calls.push(["navigateRemoteDebugTarget", targetUrlPart, targetUrl, options.remoteDebugPort]);
      return {
        ok: true,
        frameId: "frame-1",
      };
    },
    async navigatePortalRoute() {
      calls.push("navigatePortalRoute");
      throw new Error("page JavaScript navigation should not be used");
    },
    async waitForRemoteDebugTarget(targetUrlPart, options) {
      calls.push(["waitForRemoteDebugTarget", targetUrlPart, options.remoteDebugPort]);
      return {
        id: "setting-target",
        url: "file:///Applications/EasyConnect.app/Contents/Resources/Web/local/connect/connect.html",
      };
    },
  };

  const service = new VpnService({
    runtimeFactory: () => fakeRuntime,
  });

  const result = await service.prepareOfficialUiRepairSmokeTarget(
    {
      vpn: {
        remoteDebugPort: 9333,
      },
    },
    {
      allowServiceTargetMutation: true,
    },
  );

  assert.equal(result.action, "prepared-by-mutating-service-target");
  assert.deepEqual(calls.filter((call) => Array.isArray(call) && call[0] === "navigateRemoteDebugTarget"), [
    [
      "navigateRemoteDebugTarget",
      "/portal/#!/user_setting_box",
      "file:///Applications/EasyConnect.app/Contents/Resources/Web/local/connect/connect.html",
      9333,
    ],
  ]);
  assert.equal(calls.includes("navigatePortalRoute"), false);
});

test("VpnService.recoverAndLogin uses ensureOnline main path and redacts sensitive fields", async () => {
  const calls = [];
  const fakeRuntime = {
    async getGatewayCandidates() {
      calls.push("getGatewayCandidates");
      return [{ host: "203.0.113.10", port: 9898 }];
    },
  };

  const service = new VpnService({
    runtimeFactory: () => fakeRuntime,
    gatewayLoginFactory: ({ host, port }) => ({ host, port, kind: "gateway-login" }),
    dataPlaneProbeFn: async (config) => {
      calls.push(["probeDataPlane", config.vpn.dataPlaneProbeTarget]);
      return {
        configured: true,
        ok: true,
        state: "reachable",
        target: config.vpn.dataPlaneProbeTarget,
      };
    },
    ensureOnlineFn: async (options) => {
      calls.push({
        gatewayHost: options.gatewayHost,
        gatewayPort: options.gatewayPort,
        username: options.username,
        password: options.password,
        gatewayLoginKind: options.gatewayLogin.kind,
      });

      return {
        action: "relogin-page-bridge",
        auth: {
          cookie: "TWFID=secret-cookie",
          summary: {
            twfId: "secret-session",
          },
        },
        login: {
          summary: {
            effectiveTwfId: "secret-session",
          },
        },
        bridge: {
          token: "derived-token",
        },
      };
    },
  });

  const result = await service.recoverAndLogin(
    {
      vpn: {
        username: "demo-user",
        password: "secret",
        gateways: [{ host: "203.0.113.10", port: 9898 }],
        dataPlaneProbeTarget: "tcp://192.168.150.199:1521",
      },
    },
    "demo-user",
    "secret",
    9222,
  );

  assert.equal(result.action, "relogin-page-bridge");
  assert.deepEqual(result.gateway, { host: "203.0.113.10", port: 9898 });
  assert.equal(result.auth.cookie, undefined);
  assert.equal(result.auth.summary.twfId, undefined);
  assert.equal(result.login.summary.effectiveTwfId, undefined);
  assert.equal(result.bridge.token, undefined);
  assert.equal(result.dataPlane.ok, true);
  assert.deepEqual(result.gatewayAttempts, [{ gateway: "203.0.113.10:9898", ok: true }]);
  assert.deepEqual(calls, [
    {
      gatewayHost: "203.0.113.10",
      gatewayPort: 9898,
      username: "demo-user",
      password: "secret",
      gatewayLoginKind: "gateway-login",
    },
    ["probeDataPlane", "tcp://192.168.150.199:1521"],
  ]);
});

test("VpnService.recoverAndLogin falls back to portal recovery when the main path fails", async () => {
  const calls = [];
  const fakeRuntime = {
    async getGatewayCandidates() {
      calls.push("getGatewayCandidates");
      return [{ host: "203.0.113.10", port: 9898 }];
    },
    async recoverLoginViaPageBridge() {
      throw new Error("page bridge should be skipped for captcha-style failures");
    },
    async recoverLoginViaUserDebug(options) {
      calls.push(["recoverLoginViaUserDebug", options]);
      return {
        recovery: {
          mode: "portal-debug",
        },
        online: {
          activeSession: {
            token: "secret-token",
            sessionId: "session-2",
          },
          loginStatus: {
            status: "1",
          },
        },
      };
    },
  };

  const service = new VpnService({
    runtimeFactory: () => fakeRuntime,
    gatewayLoginFactory: ({ host, port }) => ({ host, port, kind: "gateway-login" }),
    ensureOnlineFn: async () => {
      throw new Error("Gateway requires captcha; automatic password login is blocked");
    },
  });

  const result = await service.recoverAndLogin(
    {
      vpn: {
        username: "demo-user",
        password: "secret",
        gateways: [{ host: "203.0.113.10", port: 9898 }],
      },
    },
    "demo-user",
    "secret",
    9222,
  );

  assert.equal(result.mode, "fallback-portal-debug");
  assert.deepEqual(result.gateway, { host: "203.0.113.10", port: 9898 });
  assert.equal(result.error, "Gateway requires captcha; automatic password login is blocked");
  assert.equal(result.online.activeSession.token, undefined);
  assert.deepEqual(result.gatewayAttempts, [
    {
      gateway: "203.0.113.10:9898",
      ok: false,
      error: "Gateway requires captcha; automatic password login is blocked",
    },
  ]);
  assert.deepEqual(calls, [
    ["recoverLoginViaUserDebug", { username: "demo-user", password: "secret", remoteDebugPort: 9222 }],
  ]);
});

test("VpnService.recoverAndLogin tries page-bridge recovery before portal fallback for non-captcha failures", async () => {
  const calls = [];
  const fakeRuntime = {
    async getGatewayCandidates() {
      calls.push("getGatewayCandidates");
      return [{ host: "203.0.113.10", port: 9898 }];
    },
    async recoverLoginViaPageBridge(options) {
      calls.push(["recoverLoginViaPageBridge", options]);
      return {
        recovery: {
          mode: "page-bridge",
        },
        loginSummary: {
          effectiveTwfId: "session-3",
        },
        bridge: {
          ok: true,
          sessionId: "session-3",
        },
        online: {
          activeSession: {
            token: "secret-token",
            sessionId: "session-3",
          },
          loginStatus: {
            status: "1",
          },
        },
      };
    },
    async recoverLoginViaUserDebug() {
      throw new Error("portal fallback should not run when page-bridge succeeds");
    },
  };

  const service = new VpnService({
    runtimeFactory: () => fakeRuntime,
    gatewayLoginFactory: ({ host, port }) => ({ host, port, kind: "gateway-login" }),
    ensureOnlineFn: async () => {
      throw new Error("DoXmlConfigure(1) failed: request token check error");
    },
  });

  const result = await service.recoverAndLogin(
    {
      vpn: {
        username: "demo-user",
        password: "secret",
        gateways: [{ host: "203.0.113.10", port: 9898 }],
      },
    },
    "demo-user",
    "secret",
    9222,
  );

  assert.equal(result.mode, "fallback-page-bridge");
  assert.deepEqual(result.gateway, { host: "203.0.113.10", port: 9898 });
  assert.equal(result.error, "DoXmlConfigure(1) failed: request token check error");
  assert.equal(result.online.activeSession.token, undefined);
  assert.deepEqual(result.gatewayAttempts, [
    {
      gateway: "203.0.113.10:9898",
      ok: false,
      error: "DoXmlConfigure(1) failed: request token check error",
    },
  ]);
  assert.deepEqual(calls, [
    [
      "recoverLoginViaPageBridge",
      {
        gatewayLogin: { host: "203.0.113.10", port: 9898, kind: "gateway-login" },
        gatewayHost: "203.0.113.10",
        gatewayPort: 9898,
        username: "demo-user",
        password: "secret",
        remoteDebugPort: 9222,
      },
    ],
  ]);
});

test("VpnService.recoverAndLogin tries multiple gateways before falling back", async () => {
  const calls = [];
  const fakeRuntime = {
    async getGatewayCandidates() {
      calls.push("getGatewayCandidates");
      return [
        { host: "203.0.113.10", port: 9000 },
        { host: "198.51.100.20", port: 9898 },
      ];
    },
    async recoverLoginViaUserDebug(options) {
      calls.push(["recoverLoginViaUserDebug", options]);
      throw new Error("portal fallback should not run when a later gateway succeeds");
    },
  };

  const service = new VpnService({
    runtimeFactory: () => fakeRuntime,
    gatewayLoginFactory: ({ host, port }) => ({ host, port, kind: `${host}:${port}` }),
    ensureOnlineFn: async (options) => {
      calls.push(["ensureOnline", options.gatewayHost, options.gatewayPort]);
      if (options.gatewayPort === 9000) {
        throw new Error("gateway 9000 offline");
      }

      return {
        action: "relogin-page-bridge",
        bridge: {
          token: "derived-token",
        },
      };
    },
  });

  const result = await service.recoverAndLogin(
    {
      vpn: {
        username: "demo-user",
        password: "secret",
        gateways: [
          { host: "203.0.113.10", port: 9000 },
          { host: "198.51.100.20", port: 9898 },
        ],
        lastKnownGateway: null,
      },
    },
    "demo-user",
    "secret",
    9222,
  );

  assert.equal(result.action, "relogin-page-bridge");
  assert.deepEqual(result.gateway, { host: "198.51.100.20", port: 9898 });
  assert.deepEqual(result.gatewayAttempts, [
    { gateway: "203.0.113.10:9000", ok: false, error: "gateway 9000 offline" },
    { gateway: "198.51.100.20:9898", ok: true },
  ]);
  assert.deepEqual(calls, [
    ["ensureOnline", "203.0.113.10", 9000],
    ["ensureOnline", "198.51.100.20", 9898],
  ]);
});

test("VpnService.recoverAndLogin uses provided gatewayCandidates without runtime discovery", async () => {
  const calls = [];
  const fakeRuntime = {
    async getGatewayCandidates() {
      calls.push("getGatewayCandidates");
      return [{ host: "should-not-be-used", port: 1 }];
    },
    async recoverLoginViaUserDebug() {
      throw new Error("fallback should not run");
    },
  };

  const service = new VpnService({
    runtimeFactory: () => fakeRuntime,
    gatewayLoginFactory: ({ host, port }) => ({ host, port }),
    ensureOnlineFn: async (options) => {
      calls.push(["ensureOnline", options.gatewayHost, options.gatewayPort]);
      return {
        action: "already-online",
      };
    },
  });

  const result = await service.recoverAndLogin(
    {
      vpn: {
        username: "demo-user",
        password: "secret",
        gateways: [],
        lastKnownGateway: null,
      },
    },
    "demo-user",
    "secret",
    9222,
    [{ host: "203.0.113.10", port: 9898 }],
  );

  assert.equal(result.action, "already-online");
  assert.deepEqual(result.gateway, { host: "203.0.113.10", port: 9898 });
  assert.deepEqual(result.gatewayAttempts, [{ gateway: "203.0.113.10:9898", ok: true }]);
  assert.deepEqual(calls, [["ensureOnline", "203.0.113.10", 9898]]);
});

test("VpnService.getRecoveryPlan exposes the ordered gateway plan and fallback", async () => {
  const fakeRuntime = {
    async getGatewayCandidates() {
      return [{ host: "203.0.113.10", port: 9898 }];
    },
  };

  const service = new VpnService({
    runtimeFactory: () => fakeRuntime,
  });

  const plan = await service.getRecoveryPlan(
    {
      vpn: {
        gateways: [
          { host: "203.0.113.10", port: 9898 },
          { host: "198.51.100.20", port: 9898 },
        ],
        lastKnownGateway: { host: "198.51.100.20", port: 9898 },
      },
    },
    [{ host: "203.0.113.10", port: 9000 }],
  );

  assert.deepEqual(plan, {
    gateways: [
      { host: "198.51.100.20", port: 9898, source: "lastKnown" },
      { host: "203.0.113.10", port: 9898, source: "configured" },
    ],
    fallback: "portal-debug",
  });
});

test("VpnService.probeRecoveryGateways annotates reachability and captcha requirements", async () => {
  const fakeRuntime = {
    async getGatewayCandidates() {
      return [];
    },
  };

  const gatewayCalls = [];
  const service = new VpnService({
    runtimeFactory: () => fakeRuntime,
    gatewayLoginFactory: ({ host, port }) => ({
      async loginAuth() {
        gatewayCalls.push(["loginAuth", host, port]);
        return {
          cookie: `TWFID=${host}:${port}`,
          summary: {},
        };
      },
      async passwordConfig(cookie) {
        gatewayCalls.push(["passwordConfig", host, port, cookie]);
        if (host === "198.51.100.20") {
          return {
            summary: {
              useRandCode: "1",
            },
          };
        }

        return {
          summary: {
            useRandCode: "0",
          },
        };
      },
    }),
  });

  const result = await service.probeRecoveryGateways(
    {
      vpn: {
        gateways: [
          { host: "203.0.113.10", port: 9898 },
          { host: "198.51.100.20", port: 9898 },
        ],
        lastKnownGateway: { host: "198.51.100.20", port: 9898 },
      },
    },
    [{ host: "203.0.113.10", port: 9000 }],
  );

  assert.deepEqual(result, [
    {
      host: "198.51.100.20",
      port: 9898,
      source: "lastKnown",
      reachable: true,
      captchaRequired: true,
      recommended: false,
    },
    {
      host: "203.0.113.10",
      port: 9898,
      source: "configured",
      reachable: true,
      captchaRequired: false,
      recommended: true,
    },
  ]);

  assert.deepEqual(gatewayCalls, [
    ["loginAuth", "198.51.100.20", 9898],
    ["passwordConfig", "198.51.100.20", 9898, "TWFID=198.51.100.20:9898"],
    ["loginAuth", "203.0.113.10", 9898],
    ["passwordConfig", "203.0.113.10", 9898, "TWFID=203.0.113.10:9898"],
  ]);
});

test("VpnService.probeRecoveryGateways reports unreachable gateways", async () => {
  const service = new VpnService({
    runtimeFactory: () => ({
      async getGatewayCandidates() {
        return [];
      },
    }),
    gatewayLoginFactory: ({ host, port }) => ({
      async loginAuth() {
        throw new Error(`connect ${host}:${port} failed`);
      },
    }),
  });

  const result = await service.probeRecoveryGateways(
    {
      vpn: {
        gateways: [{ host: "203.0.113.10", port: 9898 }],
      },
    },
    [],
  );

  assert.deepEqual(result, [
    {
      host: "203.0.113.10",
      port: 9898,
      source: "configured",
      reachable: false,
      captchaRequired: null,
      recommended: false,
      error: "connect 203.0.113.10:9898 failed",
    },
  ]);
});
