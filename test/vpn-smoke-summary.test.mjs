import test from "node:test";
import assert from "node:assert/strict";

import {
  assertGatewayConfigUnchanged,
  assertMaintainerOnline,
  assertMaintainerRecoveredFromOffline,
  assertNoPersistedGateways,
  summarizeMaintainerStatus,
} from "../src/services/vpn-smoke-summary.js";

test("summarizeMaintainerStatus includes official UI repair result for smoke output", () => {
  const summary = summarizeMaintainerStatus({
    running: true,
    gateway: {
      host: "198.51.100.20",
      port: 9898,
    },
    lastEvent: {
      ok: true,
      result: {
        action: "already-online",
        activeSession: {
          sessionId: "session-1",
          token: "secret-token",
        },
        loginStatus: {
          status: "1",
        },
        serviceState: {
          base: "18",
          l3vpn: "18",
          tcp: "43",
        },
        officialUiRepair: {
          action: "already-consistent",
          status: {
            activeSession: {
              sessionId: "session-1",
              token: "nested-secret-token",
            },
          },
        },
      },
    },
  });

  assert.deepEqual(summary.lastEvent.officialUiRepair, {
    action: "already-consistent",
    reason: null,
    error: null,
    gateway: null,
  });
  assert.equal(summary.lastEvent.activeSession.token, undefined);
});

test("assertMaintainerOnline fails when official UI repair was not exercised", () => {
  const status = {
    lastEvent: {
      ok: true,
      result: {
        action: "already-online",
        activeSession: {
          sessionId: "session-1",
        },
        loginStatus: {
          status: "1",
        },
      },
    },
  };

  assert.throws(
    () => assertMaintainerOnline(status, "VPN autostart"),
    /official UI repair/i,
  );
});

test("smoke helpers preserve official UI repair when online payload is wrapped", () => {
  const status = {
    lastEvent: {
      ok: true,
      result: {
        mode: "fallback-page-bridge",
        officialUiRepair: {
          action: "repair-official-ui",
          gateway: {
            host: "203.0.113.10",
            port: 9898,
          },
        },
        online: {
          activeSession: {
            sessionId: "session-2",
          },
          loginStatus: {
            status: "1",
          },
        },
      },
    },
  };

  assert.equal(assertMaintainerOnline(status, "VPN keepalive"), status);
  assert.deepEqual(summarizeMaintainerStatus(status).lastEvent.officialUiRepair, {
    action: "repair-official-ui",
    reason: null,
    error: null,
    gateway: {
      host: "203.0.113.10",
      port: 9898,
    },
  });
});

test("assertMaintainerRecoveredFromOffline requires a real recovery action and healthy services", () => {
  const status = {
    lastEvent: {
      ok: true,
      result: {
        action: "relogin-page-bridge",
        gatewayAttempts: [
          {
            gateway: "203.0.113.10:9898",
            ok: true,
          },
        ],
        activeSession: {
          sessionId: "session-3",
        },
        loginStatus: {
          status: "1",
        },
        serviceState: {
          base: "18",
          l3vpn: "18",
          tcp: "43",
        },
        officialUiRepair: {
          action: "already-consistent",
        },
      },
    },
  };

  assert.equal(assertMaintainerRecoveredFromOffline(status, "VPN offline recovery"), status);
});

test("assertMaintainerRecoveredFromOffline rejects already-online cycles", () => {
  const status = {
    lastEvent: {
      ok: true,
      result: {
        action: "already-online",
        activeSession: {
          sessionId: "session-4",
        },
        loginStatus: {
          status: "1",
        },
        serviceState: {
          base: "18",
          l3vpn: "18",
          tcp: "43",
        },
        officialUiRepair: {
          action: "already-consistent",
        },
      },
    },
  };

  assert.throws(
    () => assertMaintainerRecoveredFromOffline(status, "VPN offline recovery"),
    /real recovery action/i,
  );
});

test("gateway config smoke guard rejects persisted invalid gateways", () => {
  const invalidGateways = [
    {
      host: "127.0.0.1",
      port: 1,
    },
  ];

  assert.throws(
    () =>
      assertNoPersistedGateways(
        {
          vpn: {
            lastKnownGateway: {
              host: "127.0.0.1",
              port: 1,
            },
            gateways: [
              {
                host: "203.0.113.10",
                port: 9898,
              },
            ],
          },
        },
        invalidGateways,
        "VPN failure-state",
      ),
    /persisted invalid gateway/i,
  );
});

test("gateway config smoke guard accepts unchanged gateway config", () => {
  const before = {
    vpn: {
      lastKnownGateway: {
        host: "203.0.113.10",
        port: 9898,
      },
      gateways: [
        {
          host: "203.0.113.10",
          port: 9898,
        },
        {
          host: "198.51.100.20",
          port: 9898,
        },
      ],
    },
  };
  const after = JSON.parse(JSON.stringify(before));

  assert.equal(assertGatewayConfigUnchanged(before, after, "VPN failure-state"), after);
});
