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
