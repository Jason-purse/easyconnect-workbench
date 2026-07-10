import test from "node:test";
import assert from "node:assert/strict";

import { runOfficialUiRepairSmoke } from "../src/services/vpn-official-ui-repair-smoke.js";

test("runOfficialUiRepairSmoke refuses to run when VPN is offline", async () => {
  const calls = [];
  const vpnService = {
    async getSnapshot() {
      calls.push("getSnapshot");
      return {
        status: {
          activeSession: null,
          loginStatus: { status: "0" },
        },
      };
    },
    async prepareOfficialUiRepairSmokeTarget() {
      calls.push("prepareOfficialUiRepairSmokeTarget");
    },
    async repairOfficialUi() {
      calls.push("repairOfficialUi");
    },
  };

  await assert.rejects(
    runOfficialUiRepairSmoke({
      vpnService,
      config: {},
      onlineWaitMs: 0,
    }),
    /requires VPN to be online/i,
  );

  assert.deepEqual(calls, ["getSnapshot"]);
});

test("runOfficialUiRepairSmoke waits for transient active-session discovery", async () => {
  const calls = [];
  let snapshotCalls = 0;
  const vpnService = {
    async getSnapshot() {
      calls.push("getSnapshot");
      snapshotCalls += 1;
      if (snapshotCalls < 3) {
        return {
          status: {
            activeSession: null,
            loginStatus: null,
          },
        };
      }

      return {
        status: {
          activeSession: { sessionId: "session-1" },
          loginStatus: { status: "1" },
          serviceState: { base: "18", l3vpn: "18", tcp: "43" },
        },
      };
    },
    async prepareOfficialUiRepairSmokeTarget() {
      calls.push("prepareOfficialUiRepairSmokeTarget");
      return {
        action: "skip-no-test-target",
        reason: "DevTools target creation is unavailable",
      };
    },
    async repairOfficialUi() {
      calls.push("repairOfficialUi");
    },
  };

  const result = await runOfficialUiRepairSmoke({
    vpnService,
    config: {},
    onlineWaitMs: 50,
    onlinePollMs: 1,
  });

  assert.equal(result.action, "skip-no-test-target");
  assert.equal(result.onlineProbeAttempts, 3);
  assert.deepEqual(calls, [
    "getSnapshot",
    "getSnapshot",
    "getSnapshot",
    "prepareOfficialUiRepairSmokeTarget",
  ]);
});

test("runOfficialUiRepairSmoke prepares a safe abnormal target and validates the repair branch", async () => {
  const calls = [];
  const vpnService = {
    async getSnapshot(config, options) {
      calls.push(["getSnapshot", config, options]);
      return {
        status: {
          activeSession: { sessionId: "session-1" },
          loginStatus: { status: "1" },
          serviceState: { base: "18", l3vpn: "18", tcp: "43" },
        },
      };
    },
    async prepareOfficialUiRepairSmokeTarget(config, options) {
      calls.push(["prepareOfficialUiRepairSmokeTarget", config, options.remoteDebugPort]);
      return {
        action: "prepared-test-target",
        targetUrl: "file:///Applications/EasyConnect.app/Contents/Resources/Web/local/connect/connect.html",
      };
    },
    async repairOfficialUi(config, options) {
      calls.push(["repairOfficialUi", config, options.remoteDebugPort]);
      return {
        action: "repair-official-ui",
        from: { kind: "connect" },
        bridge: { ok: true, token: "must-not-leak" },
        serviceSync: { ok: true, token: "must-not-leak" },
      };
    },
  };

  const result = await runOfficialUiRepairSmoke({
    vpnService,
    config: {
      vpn: {
        remoteDebugPort: 9333,
      },
    },
  });

  assert.equal(result.action, "repair-official-ui-smoke");
  assert.equal(result.preparedTarget.action, "prepared-test-target");
  assert.equal(result.repair.action, "repair-official-ui");
  assert.equal(result.repair.bridge.token, undefined);
  assert.equal(result.repair.serviceSync.token, undefined);
  assert.deepEqual(
    calls.map((call) => (Array.isArray(call) ? call[0] : call)),
    ["getSnapshot", "prepareOfficialUiRepairSmokeTarget", "repairOfficialUi"],
  );
});

test("runOfficialUiRepairSmoke accepts a controlled service-target mutation as repair preparation", async () => {
  const calls = [];
  const vpnService = {
    async getSnapshot() {
      calls.push("getSnapshot");
      return {
        status: {
          activeSession: { sessionId: "session-1" },
          loginStatus: { status: "1" },
          serviceState: { base: "18", l3vpn: "18", tcp: "43" },
        },
      };
    },
    async prepareOfficialUiRepairSmokeTarget(config, options) {
      calls.push(["prepareOfficialUiRepairSmokeTarget", options.allowServiceTargetMutation]);
      return {
        action: "prepared-by-mutating-service-target",
        targetUrl: "file:///Applications/EasyConnect.app/Contents/Resources/Web/local/connect/connect.html",
      };
    },
    async repairOfficialUi() {
      calls.push("repairOfficialUi");
      return {
        action: "repair-official-ui",
        from: { kind: "connect" },
      };
    },
  };

  const result = await runOfficialUiRepairSmoke({
    vpnService,
    config: {},
    allowServiceTargetMutation: true,
  });

  assert.equal(result.action, "repair-official-ui-smoke");
  assert.equal(result.preparedTarget.action, "prepared-by-mutating-service-target");
  assert.deepEqual(
    calls.map((call) => (Array.isArray(call) ? call[0] : call)),
    ["getSnapshot", "prepareOfficialUiRepairSmokeTarget", "repairOfficialUi"],
  );
});

test("runOfficialUiRepairSmoke returns a clear skip when no safe test target can be created", async () => {
  const calls = [];
  const vpnService = {
    async getSnapshot() {
      calls.push("getSnapshot");
      return {
        status: {
          activeSession: { sessionId: "session-1" },
          loginStatus: { status: "1" },
        },
      };
    },
    async prepareOfficialUiRepairSmokeTarget() {
      calls.push("prepareOfficialUiRepairSmokeTarget");
      return {
        action: "skip-no-test-target",
        reason: "DevTools target creation is unavailable",
      };
    },
    async repairOfficialUi() {
      calls.push("repairOfficialUi");
    },
  };

  const result = await runOfficialUiRepairSmoke({
    vpnService,
    config: {},
  });

  assert.equal(result.action, "skip-no-test-target");
  assert.match(result.reason, /unavailable/i);
  assert.deepEqual(calls, ["getSnapshot", "prepareOfficialUiRepairSmokeTarget"]);
});

test("runOfficialUiRepairSmoke reuses an existing blocked official target when target creation is unavailable", async () => {
  const calls = [];
  const vpnService = {
    async getSnapshot() {
      calls.push("getSnapshot");
      return {
        status: {
          activeSession: { sessionId: "session-1" },
          loginStatus: { status: "1" },
          serviceState: { base: "18", l3vpn: "18", tcp: "43" },
          officialUi: {
            hasBlockingVisibleTarget: true,
            primaryTarget: {
              kind: "connect",
              url: "file:///Applications/EasyConnect.app/Contents/Resources/Web/local/connect/connect.html",
            },
          },
        },
      };
    },
    async prepareOfficialUiRepairSmokeTarget() {
      calls.push("prepareOfficialUiRepairSmokeTarget");
      return {
        action: "skip-no-test-target",
        reason: "Could not create new page",
      };
    },
    async repairOfficialUi() {
      calls.push("repairOfficialUi");
      return {
        action: "repair-official-ui",
        from: { kind: "connect" },
      };
    },
  };

  const result = await runOfficialUiRepairSmoke({
    vpnService,
    config: {},
  });

  assert.equal(result.action, "repair-official-ui-smoke");
  assert.equal(result.preparedTarget.action, "use-existing-blocking-target");
  assert.equal(result.repair.action, "repair-official-ui");
  assert.deepEqual(calls, ["getSnapshot", "prepareOfficialUiRepairSmokeTarget", "repairOfficialUi"]);
});
