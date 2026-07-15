import test from "node:test";
import assert from "node:assert/strict";

import {
  deriveConnectionView,
  deriveMaintainerActivity,
  deriveMaintainerSchedule,
  deriveMaintainerView,
  describeMaintainerStartResult,
  resolveDataPlaneForRender,
} from "../src/renderer/view-state.js";

test("online state exposes refresh as the single primary action", () => {
  assert.deepEqual(
    deriveConnectionView({
      status: {
        loginStatus: { status: "1" },
        dataPlane: { configured: true, ok: true, state: "reachable" },
      },
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

test("control-plane online does not claim protection when the data plane is unreachable", () => {
  const view = deriveConnectionView({
    status: {
      loginStatus: { status: "1" },
      dataPlane: {
        configured: true,
        ok: false,
        state: "unreachable",
        target: "tcp://192.168.150.199:1521",
      },
    },
    environmentInfo: { appExecutableExists: true },
    maintainerStatus: { running: true },
  });

  assert.equal(view.tone, "warning");
  assert.equal(view.label, "数据通道异常");
  assert.equal(view.title, "内网连接不可达");
  assert.equal(view.primaryAction, "refresh");
  assert.equal(view.primaryLabel, "重新检查");
});

test("control-plane online remains unverified until a probe target is configured", () => {
  const view = deriveConnectionView({
    status: {
      loginStatus: { status: "1" },
      dataPlane: { configured: false, ok: null, state: "unconfigured" },
    },
    environmentInfo: { appExecutableExists: true },
    maintainerStatus: { running: true },
  });

  assert.equal(view.tone, "warning");
  assert.equal(view.label, "连接未验证");
  assert.equal(view.title, "需要配置连接验证");
  assert.equal(view.primaryAction, "open-settings");
  assert.equal(view.primaryLabel, "配置探活目标");
});

test("control-plane online waits for a current probe instead of reporting failure", () => {
  const view = deriveConnectionView({
    status: {
      loginStatus: { status: "1" },
      dataPlane: {
        configured: true,
        ok: null,
        state: "pending",
        target: "tcp://192.0.2.11:1521",
      },
    },
    environmentInfo: { appExecutableExists: true },
    maintainerStatus: { running: true },
  });

  assert.equal(view.tone, "warning");
  assert.equal(view.label, "连接待复核");
  assert.equal(view.title, "等待数据通道检查");
  assert.equal(view.primaryAction, "refresh");
  assert.equal(view.primaryLabel, "立即检查");
});

test("automatic refresh reuses only fresh evidence for the current probe target", () => {
  const snapshotStatus = { loginStatus: { status: "1" } };
  const currentMaintainerStatus = {
    running: true,
    intervalSeconds: 300,
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
        dataPlane: {
          configured: true,
          ok: true,
          state: "reachable",
          target: "tcp://192.0.2.11:1521",
        },
      },
    },
  };

  assert.equal(
    resolveDataPlaneForRender(snapshotStatus, currentMaintainerStatus, {
      nowMs: Date.parse("2026-07-15T09:00:01.000Z"),
    }).ok,
    true,
  );

  const changedTarget = {
    ...currentMaintainerStatus,
    dataPlaneProbe: {
      ...currentMaintainerStatus.dataPlaneProbe,
      target: "tcp://192.0.2.12:1521",
    },
  };
  assert.deepEqual(
    resolveDataPlaneForRender(snapshotStatus, changedTarget, {
      nowMs: Date.parse("2026-07-15T09:00:01.000Z"),
    }),
    changedTarget.dataPlaneProbe,
  );

  const newerManualFailure = {
    ...currentMaintainerStatus,
    dataPlaneObservation: {
      observedAt: "2026-07-15T09:00:02.000Z",
      dataPlaneProbeRevision: 1,
      activeSession: { sessionId: "session-1" },
      loginStatus: { status: "1" },
      dataPlane: {
        configured: true,
        ok: false,
        state: "unreachable",
        target: "tcp://192.0.2.11:1521",
        code: "VPN_DATA_PLANE_UNREACHABLE",
      },
    },
    dataPlaneProbeRevision: 1,
  };
  assert.equal(
    resolveDataPlaneForRender(snapshotStatus, newerManualFailure, {
      nowMs: Date.parse("2026-07-15T09:00:03.000Z"),
    }).ok,
    false,
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

test("authoritative quiet-hours state overrides running and stale events", () => {
  const quietStatus = {
    running: true,
    quietHours: { active: true, start: "18:30", end: "09:00" },
  };
  assert.equal(
    deriveConnectionView({
      status: {},
      environmentInfo: { appExecutableExists: true },
      maintainerStatus: quietStatus,
    }).primaryAction,
    "refresh",
  );
  assert.equal(deriveMaintainerView({ maintainerStatus: quietStatus }).state, "quiet");
  assert.equal(deriveMaintainerView({ maintainerStatus: quietStatus }).action, null);

  const staleQuietEvent = {
    running: false,
    quietHours: { active: false, start: "18:30", end: "09:00" },
    lastEvent: { result: { action: "keepalive-paused-quiet-hours" } },
  };
  assert.equal(
    deriveConnectionView({
      status: {},
      environmentInfo: { appExecutableExists: true },
      maintainerStatus: staleQuietEvent,
    }).tone,
    "offline",
  );
});

test("recovering state disables the connection action", () => {
  const view = deriveConnectionView({
    status: {},
    environmentInfo: { appExecutableExists: true },
    maintainerStatus: { running: true, currentPhase: "official-renderer-login" },
  });
  assert.equal(view.tone, "progress");
  assert.equal(view.primaryAction, null);
  assert.equal(view.primaryLabel, "正在连接");
});

test("captcha and private-kick failures direct the user to the official client", () => {
  for (const lastEvent of [
    { ok: false, error: "Gateway requires captcha; automatic password login is blocked" },
    { ok: false, code: "EASYCONNECT_PRIVATE_KICK", error: "same user login" },
  ]) {
    const view = deriveConnectionView({
      status: {},
      environmentInfo: { appExecutableExists: true },
      maintainerStatus: { running: true, lastEvent },
    });
    assert.equal(view.tone, "warning");
    assert.equal(view.primaryAction, "launch-client");
    assert.equal(view.primaryLabel, "打开官方客户端");
  }
});

test("local readiness failures wait for the next maintainer check instead of starting another recovery", () => {
  const view = deriveConnectionView({
    status: {},
    environmentInfo: { appExecutableExists: true },
    maintainerStatus: {
      running: true,
      lastEvent: {
        ok: false,
        code: "EASYCONNECT_LOCAL_SERVICE_NOT_READY",
        error: "local service not ready",
      },
    },
  });
  assert.equal(view.tone, "warning");
  assert.equal(view.primaryAction, "refresh");
  assert.equal(view.primaryLabel, "重新检查");
});

test("deriveMaintainerActivity records each completed maintainer event once", () => {
  const maintainerStatus = {
    lastEventAt: "2026-07-13T02:00:00.000Z",
    lastEvent: {
      ok: true,
      result: {
        action: "already-online",
        dataPlane: { configured: true, ok: true, state: "reachable" },
      },
    },
  };
  const first = deriveMaintainerActivity({ maintainerStatus, previousEventAt: null });
  assert.equal(first.eventAt, maintainerStatus.lastEventAt);
  assert.equal(first.title, "保持在线");
  assert.equal(first.tone, "ok");
  assert.equal(
    deriveMaintainerActivity({
      maintainerStatus,
      previousEventAt: maintainerStatus.lastEventAt,
    }),
    null,
  );
});

test("deriveMaintainerActivity redacts credentials from failure details", () => {
  const secret = "secret-session-token";
  const activity = deriveMaintainerActivity({
    maintainerStatus: {
      lastEventAt: "2026-07-13T02:00:00.000Z",
      lastEvent: { ok: false, error: `failed {"token":"${secret}"}` },
    },
  });

  assert.equal(activity.detail.includes(secret), false);
});

test("deriveMaintainerActivity ignores lower cycle versions and older event times", () => {
  const previousEventAt = "2026-07-13T02:00:00.000Z";
  const previousCycleCount = 10;

  assert.equal(
    deriveMaintainerActivity({
      maintainerStatus: {
        cycleCount: 9,
        lastEventAt: "2026-07-13T02:01:00.000Z",
        lastEvent: { ok: true, result: { action: "already-online" } },
      },
      previousEventAt,
      previousCycleCount,
    }),
    null,
  );

  assert.equal(
    deriveMaintainerActivity({
      maintainerStatus: {
        cycleCount: 11,
        lastEventAt: "2026-07-13T01:59:00.000Z",
        lastEvent: { ok: true, result: { action: "already-online" } },
      },
      previousEventAt,
      previousCycleCount,
    }),
    null,
  );
});

test("deriveMaintainerActivity accepts a lower cycle after a newer maintainer start", () => {
  const activity = deriveMaintainerActivity({
    maintainerStatus: {
      startedAt: "2026-07-13T02:05:00.000Z",
      cycleCount: 1,
      lastEventAt: "2026-07-13T02:06:00.000Z",
      lastEvent: { ok: true, result: { action: "already-online" } },
    },
    previousStartedAt: "2026-07-13T01:00:00.000Z",
    previousCycleCount: 10,
    previousEventAt: "2026-07-13T02:00:00.000Z",
  });

  assert.equal(activity?.cycleCount, 1);
  assert.equal(activity?.startedAt, "2026-07-13T02:05:00.000Z");
});

test("suppressed maintainer starts are presented as quiet hours instead of success", () => {
  assert.deepEqual(
    describeMaintainerStartResult({
      running: false,
      startSuppressed: true,
      quietHours: { active: true, start: "18:30", end: "09:00" },
    }),
    {
      title: "静默时段",
      detail: "18:30 - 09:00 内不会启动自动恢复。静默时段结束后可再次启动。",
      tone: "warning",
    },
  );
});

test("a successful maintainer start is not reported as failed when status refresh fails", () => {
  assert.deepEqual(
    describeMaintainerStartResult(
      { running: true, quietHours: { active: false } },
      { refreshError: new Error("status refresh timed out") },
    ),
    {
      title: "自动守护已启动",
      detail: "守护已经启动，但状态刷新失败：status refresh timed out",
      tone: "warning",
    },
  );
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

test("deriveMaintainerSchedule calculates the next running check from the last event", () => {
  const lastEventAt = "2026-07-13T02:00:00.000Z";
  assert.deepEqual(
    deriveMaintainerSchedule({
      config: { vpn: { maintainerIntervalSeconds: 300 } },
      maintainerStatus: {
        running: true,
        intervalSeconds: 300,
        lastEventAt,
        lastEvent: { ok: true },
      },
      nowMs: Date.parse("2026-07-13T02:02:00.000Z"),
    }),
    {
      state: "running",
      intervalSeconds: 300,
      lastCheckAt: lastEventAt,
      nextCheckAt: "2026-07-13T02:05:00.000Z",
      resumeAt: null,
      currentCheckRunning: false,
    },
  );
});

test("deriveMaintainerSchedule uses start time while the first check is pending", () => {
  assert.equal(
    deriveMaintainerSchedule({
      config: { vpn: { maintainerIntervalSeconds: 120 } },
      maintainerStatus: {
        running: true,
        startedAt: "2026-07-13T02:00:00.000Z",
        currentPhase: "official-renderer-login",
      },
      nowMs: Date.parse("2026-07-13T02:00:10.000Z"),
    }).currentCheckRunning,
    true,
  );
});

test("deriveMaintainerSchedule keeps authoritative quiet-hours resume data", () => {
  assert.deepEqual(
    deriveMaintainerSchedule({
      config: { vpn: { maintainerIntervalSeconds: 300 } },
      maintainerStatus: {
        running: true,
        intervalSeconds: 300,
        lastEventAt: "2026-07-13T02:00:00.000Z",
        quietHours: {
          active: true,
          nextIntervalMs: 60000,
          resumeAt: "2026-07-13 09:00:00",
        },
      },
      nowMs: Date.parse("2026-07-13T02:30:00.000Z"),
    }),
    {
      state: "quiet",
      intervalSeconds: 300,
      lastCheckAt: "2026-07-13T02:00:00.000Z",
      nextCheckAt: null,
      resumeAt: "2026-07-13 09:00:00",
      currentCheckRunning: false,
    },
  );
});

test("deriveMaintainerSchedule displays stopped or unavailable timing as dashes", () => {
  assert.deepEqual(
    deriveMaintainerSchedule({
      config: { vpn: { maintainerIntervalSeconds: 300 } },
      maintainerStatus: { running: false },
      nowMs: Date.parse("2026-07-13T02:00:00.000Z"),
    }),
    {
      state: "stopped",
      intervalSeconds: null,
      lastCheckAt: null,
      nextCheckAt: null,
      resumeAt: null,
      currentCheckRunning: false,
    },
  );
});
