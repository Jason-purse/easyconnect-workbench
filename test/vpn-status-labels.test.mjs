import test from "node:test";
import assert from "node:assert/strict";

import { describeMaintainerEvent, extractStatusFromRecoverResult } from "../src/services/vpn-status-labels.js";

const REACHABLE_DATA_PLANE = {
  configured: true,
  ok: true,
  state: "reachable",
};

test("describeMaintainerEvent summarizes already-online cycles", () => {
  const summary = describeMaintainerEvent({
    ok: true,
    result: {
      action: "already-online",
      dataPlane: REACHABLE_DATA_PLANE,
    },
  });

  assert.deepEqual(summary, {
    title: "保持在线",
    detail: "VPN 已在线，本轮仅完成探活。",
    variant: "ok",
  });
});

test("describeMaintainerEvent reports automatic official UI repair", () => {
  const summary = describeMaintainerEvent({
    ok: true,
    result: {
      action: "already-online",
      dataPlane: REACHABLE_DATA_PLANE,
      officialUiRepair: {
        action: "repair-official-ui",
      },
    },
  });

  assert.deepEqual(summary, {
    title: "保持在线，官方界面已修复",
    detail: "VPN 已在线，本轮探活已在后台修复官方服务页状态，不会主动抢前台。",
    variant: "ok",
  });
});

test("describeMaintainerEvent reports quiet-hours keepalive pause", () => {
  const summary = describeMaintainerEvent({
    ok: true,
    result: {
      action: "keepalive-paused-quiet-hours",
      quietHours: {
        resumeAt: "2026/1/2 09:00:00",
      },
    },
  });

  assert.deepEqual(summary, {
    title: "自动守护已进入静默时段",
    detail: "18:30-09:00 不自动 keepalive；下一次自动检查时间：2026/1/2 09:00:00。",
    variant: "idle",
  });
});

test("describeMaintainerEvent reports a keepalive cycle deferred by a manual action", () => {
  const summary = describeMaintainerEvent({
    ok: true,
    result: {
      action: "keepalive-deferred-active-action",
      activeAction: "recover-login",
      nextIntervalMs: 30000,
    },
  });

  assert.equal(summary.title, "自动检查已顺延");
  assert.match(summary.detail, /手动操作/);
  assert.match(summary.detail, /30 秒/);
  assert.equal(summary.variant, "idle");
});

test("describeMaintainerEvent reports restored official service page", () => {
  const summary = describeMaintainerEvent({
    ok: true,
    result: {
      action: "already-online",
      dataPlane: REACHABLE_DATA_PLANE,
      officialUiRepair: {
        action: "restore-hidden-service-target",
      },
    },
  });

  assert.deepEqual(summary, {
    title: "保持在线，官方服务页已恢复",
    detail: "VPN 已在线，本轮已把官方窗口从探测页或辅助页恢复到服务页，后续周期会按冷却跳过重复修复。",
    variant: "ok",
  });
});

test("describeMaintainerEvent reports restored unreachable official UI", () => {
  const summary = describeMaintainerEvent({
    ok: true,
    result: {
      action: "already-online",
      dataPlane: REACHABLE_DATA_PLANE,
      officialUiRepair: {
        action: "restore-unreachable-official-ui",
      },
    },
  });

  assert.deepEqual(summary, {
    title: "保持在线，官方服务页已恢复",
    detail: "VPN 已在线，本轮已恢复官方 UI 调试链路并回到服务页，后续周期会按冷却跳过重复修复。",
    variant: "ok",
  });
});

test("describeMaintainerEvent keeps VPN online when official UI restore is incomplete", () => {
  const summary = describeMaintainerEvent({
    ok: true,
    result: {
      action: "already-online",
      dataPlane: REACHABLE_DATA_PLANE,
      officialUiRepair: {
        action: "restore-missing-service-target-incomplete",
        reason: "final EasyConnect page still is not a usable service target",
      },
    },
  });

  assert.deepEqual(summary, {
    title: "保持在线，官方界面待修复",
    detail: "VPN 已在线，但官方窗口仍未回到服务页：final EasyConnect page still is not a usable service target",
    variant: "warn",
  });
});

test("describeMaintainerEvent keeps VPN online when official UI repair fails", () => {
  const summary = describeMaintainerEvent({
    ok: true,
    result: {
      action: "already-online",
      dataPlane: REACHABLE_DATA_PLANE,
      officialUiRepair: {
        action: "repair-error",
        error: "DevTools target is unreachable",
      },
    },
  });

  assert.deepEqual(summary, {
    title: "保持在线，官方界面待修复",
    detail: "VPN 已在线，但官方窗口自愈失败：DevTools target is unreachable",
    variant: "warn",
  });
});

test("describeMaintainerEvent summarizes main-path relogin", () => {
  const summary = describeMaintainerEvent({
    ok: true,
    result: {
      action: "relogin-page-bridge",
      gatewayAttempts: [
        { gateway: "203.0.113.10:9000", ok: false, error: "gateway 9000 offline" },
        { gateway: "198.51.100.20:9898", ok: true },
      ],
    },
  });

  assert.deepEqual(summary, {
    title: "主链路恢复成功",
    detail: "已通过服务端登录、cookie 注入和官方页面桥接恢复 VPN。本轮尝试：203.0.113.10:9000 失败，198.51.100.20:9898 成功。",
    variant: "ok",
  });
});

test("describeMaintainerEvent summarizes fallback portal recovery", () => {
  const summary = describeMaintainerEvent({
    ok: true,
    result: {
      mode: "fallback-portal-debug",
      error: "Gateway requires captcha; automatic password login is blocked",
    },
  });

  assert.deepEqual(summary, {
    title: "兜底恢复成功",
    detail: "主链路失败后已回退到 portal 调试登录。",
    variant: "warn",
  });
});

test("describeMaintainerEvent summarizes fallback page-bridge recovery", () => {
  const summary = describeMaintainerEvent({
    ok: true,
    result: {
      mode: "fallback-page-bridge",
      gatewayAttempts: [
        { gateway: "203.0.113.10:9898", ok: false, error: "DoXmlConfigure(1) failed" },
      ],
    },
  });

  assert.deepEqual(summary, {
    title: "桥接恢复成功",
    detail: "主链路失败后已回退到官方页面桥接恢复。本轮尝试：203.0.113.10:9898 失败。",
    variant: "warn",
  });
});

test("describeMaintainerEvent classifies captcha-style failures", () => {
  const summary = describeMaintainerEvent({
    ok: false,
    error: "Gateway requires captcha; automatic password login is blocked",
    gatewayAttempts: [{ gateway: "203.0.113.10:9898", ok: false, error: "Gateway requires captcha; automatic password login is blocked" }],
  });

  assert.deepEqual(summary, {
    title: "需要人工校验",
    detail: "当前网关要求验证码或额外校验，自动恢复已暂停。本轮尝试：203.0.113.10:9898 失败。",
    variant: "warn",
  });
});

test("describeMaintainerEvent classifies missing-gateway failures", () => {
  const summary = describeMaintainerEvent({
    ok: false,
    error: "No gateway available for recoverAndLogin",
  });

  assert.deepEqual(summary, {
    title: "缺少可用网关",
    detail: "当前没有可恢复的 VPN 网关，请先刷新状态或补充网关列表。",
    variant: "error",
  });
});

test("describeMaintainerEvent classifies local EasyConnect service readiness failures", () => {
  const summary = describeMaintainerEvent({
    ok: false,
    error: "Local service did not become ready before online status timeout",
    code: "EASYCONNECT_LOCAL_SERVICE_NOT_READY",
    gatewayAttempts: [
      {
        gateway: "198.51.100.20:9898",
        ok: false,
        code: "EASYCONNECT_LOCAL_SERVICE_NOT_READY",
        error: "Local service did not become ready before online status timeout",
      },
    ],
  });

  assert.deepEqual(summary, {
    title: "EasyConnect 本地服务未就绪",
    detail: "账号和网关登录链路已触发，但本机 EasyConnect 核心服务没有 ready；守护已降低重试频率，避免反复把官方界面拉回登录循环。本轮尝试：198.51.100.20:9898 失败。",
    variant: "warn",
  });
});

test("describeMaintainerEvent classifies agent proxy readiness failures", () => {
  const summary = describeMaintainerEvent({
    ok: false,
    error: "ECAgentProxy did not become ready before continuing EasyConnect recovery",
    code: "EASYCONNECT_AGENT_PROXY_NOT_READY",
    gatewayAttempts: [
      {
        gateway: "198.51.100.20:9898",
        ok: false,
        code: "EASYCONNECT_AGENT_PROXY_NOT_READY",
        error: "ECAgentProxy did not become ready before continuing EasyConnect recovery",
      },
    ],
  });

  assert.deepEqual(summary, {
    title: "EasyConnect 代理未就绪",
    detail: "ECAgentProxy 还没有 ready，守护已暂停本轮恢复并降低重试频率，避免继续拉起官方客户端进入严重错误。本轮尝试：198.51.100.20:9898 失败。",
    variant: "warn",
  });
});

test("describeMaintainerEvent classifies same-user private kick failures", () => {
  const summary = describeMaintainerEvent({
    ok: false,
    error: "EasyConnect logout detected: private same username login",
    code: "EASYCONNECT_PRIVATE_KICK",
    gatewayAttempts: [
      {
        gateway: "198.51.100.20:9898",
        ok: false,
        code: "EASYCONNECT_PRIVATE_KICK",
        error: "EasyConnect logout detected: private same username login",
      },
    ],
  });

  assert.deepEqual(summary, {
    title: "账号被其他端踢下线",
    detail: "EasyConnect 报告同用户名登录，守护已降低重试频率，避免当前机器和其他终端互相抢登录。本轮尝试：198.51.100.20:9898 失败。",
    variant: "warn",
  });
});

test("describeMaintainerEvent classifies all-gateway failures as offline", () => {
  const summary = describeMaintainerEvent({
    ok: false,
    error: "VpnMaintainer could not recover any gateway",
    gatewayAttempts: [
      { gateway: "203.0.113.10:9898", ok: false, error: "connect ECONNREFUSED" },
      { gateway: "198.51.100.20:9898", ok: false, error: "connect ETIMEDOUT" },
    ],
  });

  assert.deepEqual(summary, {
    title: "VPN 离线 / 网关不可达",
    detail: "两个已配置网关都恢复失败，请检查网络、网关地址或 EasyConnect 服务端状态。本轮尝试：203.0.113.10:9898 失败，198.51.100.20:9898 失败。",
    variant: "error",
  });
});

test("describeMaintainerEvent distinguishes a failed data-plane probe from gateway recovery", () => {
  assert.deepEqual(
    describeMaintainerEvent({
      ok: false,
      code: "VPN_DATA_PLANE_UNREACHABLE",
      error: "VPN data-plane probe failed for tcp://192.168.150.199:1521",
      dataPlane: {
        configured: true,
        ok: false,
        target: "tcp://192.168.150.199:1521",
      },
    }),
    {
      title: "数据通道不可达",
      detail: "EasyConnect 控制面显示在线，但内网探活目标 tcp://192.168.150.199:1521 当前不可达；守护将在 30 秒内重新检查。",
      variant: "error",
    },
  );
});

test("describeMaintainerEvent does not describe an unconfigured control-plane session as healthy", () => {
  assert.deepEqual(
    describeMaintainerEvent({
      ok: true,
      result: {
        action: "already-online",
        dataPlane: { configured: false, ok: null, state: "unconfigured" },
      },
    }),
    {
      title: "连接未验证",
      detail: "EasyConnect 控制面显示在线，但尚未配置内网探活目标。",
      variant: "warn",
    },
  );
});

test("describeMaintainerEvent rejects a control-plane recovery with a failed data plane", () => {
  assert.deepEqual(
    describeMaintainerEvent({
      ok: true,
      result: {
        action: "relogin-page-bridge",
        dataPlane: {
          configured: true,
          ok: false,
          target: "tcp://192.168.150.199:1521",
        },
      },
    }),
    {
      title: "数据通道不可达",
      detail: "EasyConnect 控制面显示在线，但内网探活目标 tcp://192.168.150.199:1521 当前不可达；请重新检查网络。",
      variant: "error",
    },
  );
});

test("extractStatusFromRecoverResult returns the direct main-path status payload", () => {
  const status = extractStatusFromRecoverResult({
    action: "relogin-page-bridge",
    activeSession: {
      sessionId: "session-1",
    },
    loginStatus: {
      status: "1",
    },
  });

  assert.deepEqual(status, {
    action: "relogin-page-bridge",
    activeSession: {
      sessionId: "session-1",
    },
    loginStatus: {
      status: "1",
    },
  });
});

test("extractStatusFromRecoverResult unwraps fallback portal results to the online payload", () => {
  const status = extractStatusFromRecoverResult({
    mode: "fallback-portal-debug",
    gateway: {
      host: "203.0.113.10",
      port: 9898,
    },
    error: "Gateway requires captcha; automatic password login is blocked",
    gatewayAttempts: [
      {
        gateway: "203.0.113.10:9898",
        ok: false,
        error: "Gateway requires captcha; automatic password login is blocked",
      },
    ],
    online: {
      activeSession: {
        sessionId: "session-2",
      },
      loginStatus: {
        status: "1",
      },
    },
  });

  assert.deepEqual(status, {
    mode: "fallback-portal-debug",
    gateway: {
      host: "203.0.113.10",
      port: 9898,
    },
    error: "Gateway requires captcha; automatic password login is blocked",
    gatewayAttempts: [
      {
        gateway: "203.0.113.10:9898",
        ok: false,
        error: "Gateway requires captcha; automatic password login is blocked",
      },
    ],
    activeSession: {
      sessionId: "session-2",
    },
    loginStatus: {
      status: "1",
    },
  });
});
