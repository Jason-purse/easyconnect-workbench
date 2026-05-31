import test from "node:test";
import assert from "node:assert/strict";

import { VpnService } from "../src/services/vpn-service.js";

test("VpnService.getSnapshot reuses one runtime and returns combined status/info", async () => {
  const calls = [];
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
  });

  const snapshot = await service.getSnapshot({
    vpn: {
      appExecutable: fakeRuntime.appExecutable,
    },
  });

  assert.equal(snapshot.status.activeSession.token, undefined);
  assert.equal(snapshot.environmentInfo.activeSession.token, undefined);
  assert.deepEqual(snapshot.status.loginStatus, { status: "1" });
  assert.equal(snapshot.environmentInfo.latestCachedToken, null);
  assert.deepEqual(snapshot.environmentInfo.gatewayCandidates, [{ host: "203.0.113.10", port: 9898 }]);
  assert.equal(calls.filter((item) => item === "describeActiveSession").length, 1);
  assert.equal(calls.includes("describeLatestCachedToken"), false);
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

test("VpnService.repairOfficialUi does not mutate a visible gateway probe page while VPN is online", async () => {
  const calls = [];
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
  });

  const result = await service.repairOfficialUi({
    vpn: {
      username: "demo-user",
      remoteDebugPort: 9222,
      gateways: [{ host: "198.51.100.20", port: 9898 }],
    },
  });

  assert.equal(result.action, "already-consistent");
  assert.deepEqual(calls.filter((call) => Array.isArray(call)), [
  ]);
});

test("VpnService.repairOfficialUi restores the missing service target from an online user-setting state", async () => {
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
  ]);
});

test("VpnService.repairOfficialUi closes connect_notfound residuals instead of cloning service targets", async () => {
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
          id: "notfound-target",
          type: "page",
          title: "EasyConnect",
          url: "file:///Applications/EasyConnect.app/Contents/Resources/Web/local/connect_notfound/connect_notfound.html?from=https%3A%2F%2F198.51.100.20%3A9898%2Fportal%2F%23!%2Fservice",
          webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/notfound-target",
        },
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
      const visible = target.id === "notfound-target";
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

  const result = await service.repairOfficialUi({
    vpn: {
      username: "demo-user",
      remoteDebugPort: 9222,
      gateways: [{ host: "198.51.100.20", port: 9898 }],
    },
  });

  assert.equal(result.action, "repair-official-ui");
  assert.deepEqual(calls.filter((call) => Array.isArray(call) && call[0] === "navigatePortalRoute"), []);
  assert.deepEqual(calls.filter((call) => Array.isArray(call) && call[0] === "closeOfficialWindowTarget").map((call) => call[1]), [
    "notfound-target",
  ]);
  assert.deepEqual(calls.filter((call) => Array.isArray(call) && call[0] === "navigateRemoteDebugTarget"), []);
  assert.deepEqual(calls.filter((call) => Array.isArray(call) && call[0] === "bringRemoteDebugTargetToFront"), [
    ["bringRemoteDebugTargetToFront", "service-a", 9222],
  ]);
  assert.deepEqual(result.closedResidualTargets.map((target) => [target.id, target.kind]), [
    ["notfound-target", "probe-failed"],
  ]);
  assert.deepEqual(result.repairedResidualTargets, []);
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

  const result = await service.repairOfficialUi({
    vpn: {
      username: "demo-user",
      remoteDebugPort: 9222,
      gateways: [{ host: "198.51.100.20", port: 9898 }],
    },
  });

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

test("VpnService.repairOfficialUi uses target ids after sanitizing connect_notfound URLs", async () => {
  const calls = [];
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

  assert.equal(result.action, "already-consistent");
  assert.deepEqual(calls.filter((call) => Array.isArray(call)), [
  ]);
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
  assert.deepEqual(result.gatewayAttempts, [{ gateway: "203.0.113.10:9898", ok: true }]);
  assert.deepEqual(calls, [
    {
      gatewayHost: "203.0.113.10",
      gatewayPort: 9898,
      username: "demo-user",
      password: "secret",
      gatewayLoginKind: "gateway-login",
    },
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
