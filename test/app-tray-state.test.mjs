import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTrayStatusLabels,
  buildTrayStatusSignature,
  buildTrayTooltip,
} from "../src/services/app-tray-state.js";

test("tray labels report online session from maintainer result", () => {
  const labels = buildTrayStatusLabels({
    running: true,
    gateway: {
      host: "203.0.113.10",
      port: 9898,
    },
    lastEvent: {
      ok: true,
      result: {
        action: "already-online",
        activeSession: {
          sessionId: "abcdef0123456789",
        },
        loginStatus: {
          status: "1",
        },
        dataPlane: {
          configured: true,
          ok: true,
          state: "reachable",
        },
      },
    },
  });

  assert.equal(labels.title, "EasyConnect: 在线");
  assert.equal(labels.gateway, "203.0.113.10:9898");
  assert.equal(labels.session, "abcd…6789");
  assert.equal(labels.action, "already-online");
  assert.equal(labels.canStart, false);
  assert.equal(labels.canStop, true);
});

test("tray never reports an old online event after the maintainer stops", () => {
  const labels = buildTrayStatusLabels({
    running: false,
    lastEventAt: "2026-07-15T09:00:00.000Z",
    lastEvent: {
      ok: true,
      result: {
        action: "already-online",
        activeSession: { sessionId: "abcdef0123456789" },
        loginStatus: { status: "1" },
        dataPlane: { configured: true, ok: true, state: "reachable" },
      },
    },
  });

  assert.equal(labels.online, false);
  assert.equal(labels.title, "EasyConnect: 守护已停止");
});

test("tray expires online evidence after two missed maintainer intervals", () => {
  const labels = buildTrayStatusLabels(
    {
      running: true,
      intervalSeconds: 300,
      lastEventAt: "2026-07-15T09:00:00.000Z",
      lastEvent: {
        ok: true,
        result: {
          action: "already-online",
          activeSession: { sessionId: "abcdef0123456789" },
          loginStatus: { status: "1" },
          dataPlane: { configured: true, ok: true, state: "reachable" },
        },
      },
    },
    { nowMs: Date.parse("2026-07-15T09:10:01.000Z") },
  );

  assert.equal(labels.online, false);
  assert.equal(labels.title, "EasyConnect: 连接待复核");
});

test("tray rejects successful evidence from a previously configured probe target", () => {
  const labels = buildTrayStatusLabels({
    running: true,
    dataPlaneProbe: {
      configured: true,
      ok: null,
      state: "pending",
      target: "tcp://192.0.2.11:1521",
    },
    lastEventAt: "2026-07-15T09:00:00.000Z",
    lastEvent: {
      ok: true,
      result: {
        action: "already-online",
        activeSession: { sessionId: "abcdef0123456789" },
        loginStatus: { status: "1" },
        dataPlane: {
          configured: true,
          ok: true,
          state: "reachable",
          target: "tcp://192.0.2.10:1521",
        },
      },
    },
  }, { nowMs: Date.parse("2026-07-15T09:00:01.000Z") });

  assert.equal(labels.online, false);
  assert.equal(labels.title, "EasyConnect: 连接待复核");
  assert.match(labels.detail, /探活目标已更新/);
});

test("tray prefers a newer manual data-plane failure over an older maintainer success", () => {
  const labels = buildTrayStatusLabels({
    running: true,
    intervalSeconds: 300,
    dataPlaneProbeRevision: 1,
    dataPlaneProbe: {
      configured: true,
      ok: null,
      state: "pending",
      target: "tcp://192.0.2.10:1521",
    },
    lastEventAt: "2026-07-15T09:00:05.000Z",
    lastEvent: {
      ok: true,
      result: {
        action: "already-online",
        activeSession: { sessionId: "abcdef0123456789" },
        loginStatus: { status: "1" },
        dataPlaneProbeRevision: 1,
        dataPlane: {
          configured: true,
          ok: true,
          state: "reachable",
          target: "tcp://192.0.2.10:1521",
          observedAt: "2026-07-15T09:00:00.000Z",
        },
      },
    },
    dataPlaneObservation: {
      observedAt: "2026-07-15T09:00:02.000Z",
      dataPlaneProbeRevision: 1,
      activeSession: { sessionId: "abcdef0123456789" },
      loginStatus: { status: "1" },
      dataPlane: {
        configured: true,
        ok: false,
        state: "unreachable",
        target: "tcp://192.0.2.10:1521",
        code: "VPN_DATA_PLANE_UNREACHABLE",
        error: "connect ECONNREFUSED",
      },
    },
  }, { nowMs: Date.parse("2026-07-15T09:00:03.000Z") });

  assert.equal(labels.online, false);
  assert.equal(labels.title, "EasyConnect: 数据通道不可达");
  assert.match(labels.detail, /ECONNREFUSED/);
});

test("tray prefers a newer successful observation over an older maintainer failure", () => {
  const labels = buildTrayStatusLabels({
    running: true,
    intervalSeconds: 300,
    dataPlaneProbeRevision: 1,
    dataPlaneProbe: {
      configured: true,
      ok: null,
      state: "pending",
      target: "tcp://192.0.2.10:1521",
    },
    lastEventAt: "2026-07-15T09:00:00.000Z",
    lastEvent: {
      ok: false,
      code: "VPN_DATA_PLANE_UNREACHABLE",
      error: "VPN data-plane probe failed",
      dataPlaneProbeRevision: 1,
      dataPlane: {
        configured: true,
        ok: false,
        state: "unreachable",
        target: "tcp://192.0.2.10:1521",
        observedAt: "2026-07-15T09:00:00.000Z",
        code: "VPN_DATA_PLANE_UNREACHABLE",
        error: "connect ECONNREFUSED",
      },
    },
    dataPlaneObservation: {
      observedAt: "2026-07-15T09:00:02.000Z",
      dataPlaneProbeRevision: 1,
      activeSession: { sessionId: "abcdef0123456789" },
      loginStatus: { status: "1" },
      dataPlane: {
        configured: true,
        ok: true,
        state: "reachable",
        target: "tcp://192.0.2.10:1521",
        observedAt: "2026-07-15T09:00:02.000Z",
      },
    },
  }, { nowMs: Date.parse("2026-07-15T09:00:03.000Z") });

  assert.equal(labels.online, true);
  assert.equal(labels.title, "EasyConnect: 在线");
  assert.equal(labels.variant, "ok");
  assert.doesNotMatch(labels.detail, /不可达|失败/);
});

test("tray does not report online when the control plane is stale but the data plane failed", () => {
  const labels = buildTrayStatusLabels({
    running: true,
    lastEvent: {
      ok: false,
      code: "VPN_DATA_PLANE_UNREACHABLE",
      error: "VPN data-plane probe failed",
      dataPlane: {
        configured: true,
        ok: false,
        state: "unreachable",
        target: "tcp://192.168.150.199:1521",
      },
    },
  });

  assert.equal(labels.online, false);
  assert.equal(labels.title, "EasyConnect: 数据通道不可达");
  assert.equal(labels.variant, "error");
});

test("tray reports an unverified connection when no data-plane target is configured", () => {
  const labels = buildTrayStatusLabels({
    running: true,
    lastEvent: {
      ok: true,
      result: {
        action: "already-online",
        activeSession: { sessionId: "abcdef0123456789" },
        loginStatus: { status: "1" },
        dataPlane: { configured: false, ok: null, state: "unconfigured" },
      },
    },
  });

  assert.equal(labels.online, false);
  assert.equal(labels.title, "EasyConnect: 连接未验证");
  assert.equal(labels.variant, "warn");
});

test("tray labels expose failed gateway state", () => {
  const labels = buildTrayStatusLabels({
    running: true,
    gateway: {
      host: "203.0.113.10",
      port: 9898,
    },
    lastEvent: {
      ok: false,
      error: "connect ECONNREFUSED",
      gatewayAttempts: [
        {
          gateway: "203.0.113.10:9898",
          ok: false,
        },
        {
          gateway: "198.51.100.20:9898",
          ok: false,
        },
      ],
    },
  });

  assert.equal(labels.title, "EasyConnect: 离线 / 恢复失败");
  assert.equal(labels.variant, "error");
  assert.match(labels.detail, /两个已配置网关都恢复失败/);
  assert.equal(labels.canStart, false);
  assert.equal(labels.canStop, true);
});

test("tray labels redact error details and never expose a complete short session id", () => {
  const secret = "secret-session-token";
  const labels = buildTrayStatusLabels({
    running: true,
    lastEvent: {
      ok: false,
      error: `failed {"token":"${secret}"}`,
      result: {
        activeSession: { sessionId: "session-1" },
        loginStatus: { status: "1" },
      },
    },
  });

  assert.equal(labels.detail.includes(secret), false);
  assert.notEqual(labels.session, "session-1");
});

test("tray labels suppress maintainer start during authoritative quiet hours", () => {
  const labels = buildTrayStatusLabels({
    running: false,
    quietHours: {
      active: true,
      start: "18:30",
      end: "09:00",
    },
    lastEvent: null,
  });

  assert.equal(labels.title, "EasyConnect: 静默时段");
  assert.equal(labels.variant, "quiet");
  assert.equal(labels.canStart, false);
  assert.equal(labels.canStop, false);
});

test("tray tooltip includes compact state for menu bar hover", () => {
  const tooltip = buildTrayTooltip({
    running: false,
    gateway: {
      host: "198.51.100.20",
      port: 9898,
    },
    lastEvent: null,
  });

  assert.match(tooltip, /EasyConnect: 守护已停止/);
  assert.match(tooltip, /网关: 198\.51\.100\.20:9898/);
  assert.match(tooltip, /会话: -/);
});

test("tray status signature is stable for equivalent fresh visible state", () => {
  const options = { nowMs: Date.parse("2026-05-18T09:21:00.000Z") };
  const first = buildTrayStatusSignature({
    running: true,
    gateway: {
      host: "198.51.100.20",
      port: 9898,
    },
    currentPhase: null,
    lastEvent: {
      ok: true,
      result: {
        action: "already-online",
        activeSession: {
          sessionId: "abcdef0123456789",
        },
        loginStatus: {
          status: "1",
        },
        dataPlane: {
          configured: true,
          ok: true,
          state: "reachable",
        },
      },
    },
  }, options);
  const second = buildTrayStatusSignature({
    running: true,
    gateway: {
      host: "198.51.100.20",
      port: 9898,
    },
    currentPhase: null,
    lastEventAt: "2026-05-18T09:20:29.169Z",
    cycleCount: 2,
    lastEvent: {
      ok: true,
      result: {
        action: "already-online",
        activeSession: {
          sessionId: "abcdef0123456789",
        },
        loginStatus: {
          status: "1",
        },
        dataPlane: {
          configured: true,
          ok: true,
          state: "reachable",
        },
      },
    },
  }, options);

  assert.equal(first, second);
});
