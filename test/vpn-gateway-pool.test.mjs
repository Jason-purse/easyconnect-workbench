import test from "node:test";
import assert from "node:assert/strict";

import { buildRecoveryPlan, collectRecoveryGateways } from "../src/services/vpn-gateway-pool.js";

test("collectRecoveryGateways treats configured gateways as an allowlist", () => {
  const gateways = collectRecoveryGateways(
    {
      vpn: {
        gateways: [
          { host: "203.0.113.10", port: 9898 },
          { host: "198.51.100.20", port: 9898 },
        ],
        lastKnownGateway: { host: "203.0.113.10", port: 9000 },
      },
    },
    [{ host: "203.0.113.10", port: 9000 }],
    [
      { host: "203.0.113.10", port: 9000 },
      { host: "198.51.100.20", port: 9898 },
    ],
  );

  assert.deepEqual(gateways, [
    { host: "203.0.113.10", port: 9898 },
    { host: "198.51.100.20", port: 9898 },
  ]);
});

test("collectRecoveryGateways prioritizes lastKnownGateway before configured and discovered gateways", () => {
  const gateways = collectRecoveryGateways(
    {
      vpn: {
        gateways: [
          { host: "203.0.113.10", port: 9898 },
          { host: "198.51.100.20", port: 9898 },
        ],
        lastKnownGateway: { host: "198.51.100.20", port: 9898 },
      },
    },
    [{ host: "203.0.113.10", port: 9898 }],
    [{ host: "198.51.100.20", port: 9898 }, { host: "203.0.113.10", port: 9000 }],
  );

  assert.deepEqual(gateways, [
    { host: "198.51.100.20", port: 9898 },
    { host: "203.0.113.10", port: 9898 },
  ]);
});

test("collectRecoveryGateways includes every configured gateway after the last successful gateway", () => {
  const gateways = collectRecoveryGateways(
    {
      vpn: {
        gateways: [
          { host: "203.0.113.10", port: 9898 },
          { host: "198.51.100.20", port: 9898 },
        ],
        lastKnownGateway: { host: "198.51.100.20", port: 9898 },
      },
    },
    [],
    [],
  );

  assert.deepEqual(gateways, [
    { host: "198.51.100.20", port: 9898 },
    { host: "203.0.113.10", port: 9898 },
  ]);
});

test("collectRecoveryGateways drops invalid or duplicate gateways", () => {
  const gateways = collectRecoveryGateways(
    {
      vpn: {
        gateways: [
          { host: "203.0.113.10", port: 9898 },
          { host: "198.51.100.20", port: 9898 },
        ],
        lastKnownGateway: { host: "203.0.113.10", port: 9898 },
      },
    },
    [{ host: "", port: 0 }, { host: "203.0.113.10", port: 9898 }],
    [{ host: "198.51.100.20", port: 9898 }],
  );

  assert.deepEqual(gateways, [
    { host: "203.0.113.10", port: 9898 },
    { host: "198.51.100.20", port: 9898 },
  ]);
});

test("buildRecoveryPlan does not expose runtime-discovered gateways outside configured allowlist", () => {
  const plan = buildRecoveryPlan(
    {
      vpn: {
        gateways: [
          { host: "203.0.113.10", port: 9898 },
          { host: "198.51.100.20", port: 9898 },
        ],
        lastKnownGateway: { host: "203.0.113.10", port: 9000 },
      },
    },
    [{ host: "203.0.113.10", port: 9000 }],
    [
      { host: "203.0.113.10", port: 9000 },
      { host: "198.51.100.20", port: 9898 },
    ],
  );

  assert.deepEqual(plan, {
    gateways: [
      { host: "203.0.113.10", port: 9898, source: "configured" },
      { host: "198.51.100.20", port: 9898, source: "configured" },
    ],
    fallback: "portal-debug",
  });
});

test("buildRecoveryPlan includes source labels and portal fallback", () => {
  const plan = buildRecoveryPlan(
    {
      vpn: {
        gateways: [
          { host: "203.0.113.10", port: 9898 },
          { host: "198.51.100.20", port: 9898 },
        ],
        lastKnownGateway: { host: "198.51.100.20", port: 9898 },
      },
    },
    [{ host: "203.0.113.10", port: 9898 }],
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
