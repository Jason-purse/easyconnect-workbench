import test from "node:test";
import assert from "node:assert/strict";

import { applyGatewaySelectionHint, applyProbeHints, applySnapshotHints } from "../src/services/vpn-config-hints.js";

test("applySnapshotHints stores the first discovered gateway when VPN is online", () => {
  const next = applySnapshotHints(
    {
      vpn: {
        gateways: [],
        lastKnownGateway: null,
      },
    },
    {
      status: {
        activeSession: {
          sessionId: "session-1",
        },
      },
      environmentInfo: {
        gatewayCandidates: [
          { host: "203.0.113.10", port: 9898 },
          { host: "203.0.113.10", port: 9000 },
        ],
      },
    },
  );

  assert.deepEqual(next.vpn.lastKnownGateway, {
    host: "203.0.113.10",
    port: 9898,
  });
  assert.deepEqual(next.vpn.gateways, [
    { host: "203.0.113.10", port: 9898 },
    { host: "203.0.113.10", port: 9000 },
  ]);
});

test("applySnapshotHints preserves lastKnownGateway while still learning offline candidates", () => {
  const current = {
    vpn: {
      gateways: [],
      lastKnownGateway: {
        host: "198.51.100.20",
        port: 9898,
      },
    },
  };

  const next = applySnapshotHints(current, {
    status: {
      activeSession: null,
    },
    environmentInfo: {
      gatewayCandidates: [{ host: "203.0.113.10", port: 9898 }],
    },
  });

  assert.deepEqual(next.vpn.lastKnownGateway, {
    host: "198.51.100.20",
    port: 9898,
  });
  assert.deepEqual(next.vpn.gateways, [{ host: "203.0.113.10", port: 9898 }]);
});

test("applySnapshotHints still learns gateway candidates when offline", () => {
  const next = applySnapshotHints(
    {
      vpn: {
        gateways: [],
        lastKnownGateway: null,
      },
    },
    {
      status: {
        activeSession: null,
      },
      environmentInfo: {
        gatewayCandidates: [{ host: "203.0.113.10", port: 9898 }],
      },
    },
  );

  assert.deepEqual(next.vpn.gateways, [{ host: "203.0.113.10", port: 9898 }]);
  assert.deepEqual(next.vpn.lastKnownGateway, { host: "203.0.113.10", port: 9898 });
});

test("applySnapshotHints still backfills gateways when lastKnownGateway is unchanged", () => {
  const current = {
    vpn: {
      gateways: [],
      lastKnownGateway: {
        host: "203.0.113.10",
        port: 9898,
      },
    },
  };

  const next = applySnapshotHints(current, {
    status: {
      activeSession: {
        sessionId: "session-1",
      },
    },
    environmentInfo: {
      gatewayCandidates: [{ host: "203.0.113.10", port: 9898 }],
    },
  });

  assert.deepEqual(next.vpn.lastKnownGateway, current.vpn.lastKnownGateway);
  assert.deepEqual(next.vpn.gateways, [{ host: "203.0.113.10", port: 9898 }]);
});

test("applySnapshotHints does not append newly discovered gateways outside configured allowlist", () => {
  const current = {
    vpn: {
      gateways: [{ host: "203.0.113.10", port: 9898 }],
      lastKnownGateway: {
        host: "203.0.113.10",
        port: 9898,
      },
    },
  };

  const next = applySnapshotHints(current, {
    status: {
      activeSession: {
        sessionId: "session-1",
      },
    },
    environmentInfo: {
      gatewayCandidates: [
        { host: "203.0.113.10", port: 9898 },
        { host: "198.51.100.20", port: 9898 },
      ],
    },
  });

  assert.equal(next, current);
});

test("applySnapshotHints does not learn gateways outside configured allowlist", () => {
  const current = {
    vpn: {
      gateways: [
        { host: "203.0.113.10", port: 9898 },
        { host: "198.51.100.20", port: 9898 },
      ],
      lastKnownGateway: { host: "203.0.113.10", port: 9898 },
    },
  };

  const next = applySnapshotHints(current, {
    status: {
      activeSession: {
        sessionId: "session-1",
      },
    },
    environmentInfo: {
      gatewayCandidates: [
        { host: "203.0.113.10", port: 9000 },
        { host: "198.51.100.20", port: 9898 },
      ],
    },
  });

  assert.deepEqual(next.vpn.gateways, [
    { host: "203.0.113.10", port: 9898 },
    { host: "198.51.100.20", port: 9898 },
  ]);
  assert.deepEqual(next.vpn.lastKnownGateway, {
    host: "198.51.100.20",
    port: 9898,
  });
});

test("applyGatewaySelectionHint appends the selected gateway and updates lastKnownGateway", () => {
  const next = applyGatewaySelectionHint(
    {
      vpn: {
        gateways: [],
        lastKnownGateway: null,
      },
    },
    {
      host: "198.51.100.20",
      port: 9898,
    },
  );

  assert.deepEqual(next.vpn.lastKnownGateway, {
    host: "198.51.100.20",
    port: 9898,
  });
  assert.deepEqual(next.vpn.gateways, [
    { host: "198.51.100.20", port: 9898 },
  ]);
});

test("applyGatewaySelectionHint does not append gateways outside configured allowlist", () => {
  const current = {
    vpn: {
      gateways: [
        { host: "203.0.113.10", port: 9898 },
        { host: "198.51.100.20", port: 9898 },
      ],
      lastKnownGateway: null,
    },
  };

  const next = applyGatewaySelectionHint(current, {
    host: "203.0.113.10",
    port: 9000,
  });

  assert.equal(next, current);
});

test("applyGatewaySelectionHint is a no-op when the selected gateway is already present", () => {
  const current = {
    vpn: {
      gateways: [{ host: "203.0.113.10", port: 9898 }],
      lastKnownGateway: { host: "203.0.113.10", port: 9898 },
    },
  };

  const next = applyGatewaySelectionHint(current, {
    host: "203.0.113.10",
    port: 9898,
  });

  assert.equal(next, current);
});

test("applyProbeHints learns recommended gateways and fills missing lastKnownGateway", () => {
  const next = applyProbeHints(
    {
      vpn: {
        gateways: [],
        lastKnownGateway: null,
      },
    },
    [
      {
        host: "203.0.113.10",
        port: 9000,
        reachable: true,
        captchaRequired: true,
        recommended: false,
      },
      {
        host: "198.51.100.20",
        port: 9898,
        reachable: true,
        captchaRequired: false,
        recommended: true,
      },
    ],
  );

  assert.deepEqual(next.vpn.gateways, [
    { host: "203.0.113.10", port: 9000 },
    { host: "198.51.100.20", port: 9898 },
  ]);
  assert.deepEqual(next.vpn.lastKnownGateway, { host: "198.51.100.20", port: 9898 });
});

test("applyProbeHints can replace an unreachable lastKnownGateway with a recommended one", () => {
  const next = applyProbeHints(
    {
      vpn: {
        gateways: [
          { host: "203.0.113.10", port: 9000 },
          { host: "198.51.100.20", port: 9898 },
        ],
        lastKnownGateway: { host: "203.0.113.10", port: 9000 },
      },
    },
    [
      {
        host: "203.0.113.10",
        port: 9000,
        reachable: false,
        captchaRequired: null,
        recommended: false,
      },
      {
        host: "198.51.100.20",
        port: 9898,
        reachable: true,
        captchaRequired: false,
        recommended: true,
      },
    ],
  );

  assert.deepEqual(next.vpn.lastKnownGateway, { host: "198.51.100.20", port: 9898 });
});

test("applyProbeHints ignores reachable gateways outside configured allowlist", () => {
  const current = {
    vpn: {
      gateways: [
        { host: "203.0.113.10", port: 9898 },
        { host: "198.51.100.20", port: 9898 },
      ],
      lastKnownGateway: { host: "203.0.113.10", port: 9898 },
    },
  };

  const next = applyProbeHints(current, [
    {
      host: "203.0.113.10",
      port: 9000,
      reachable: true,
      captchaRequired: false,
      recommended: true,
    },
  ]);

  assert.equal(next, current);
});
