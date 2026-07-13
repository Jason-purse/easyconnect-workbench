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

test("tray status signature is stable for equivalent visible state", () => {
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
      },
    },
  });
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
      },
    },
  });

  assert.equal(first, second);
});
