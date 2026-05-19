import test from "node:test";
import assert from "node:assert/strict";

import {
  filterGatewaysByConfigAllowlist,
  formatAllowedGateways,
  formatGateway,
  formatGatewayProbeResults,
  formatMaintainerAction,
  formatMaintainerGateway,
  formatMaintainerLastError,
  formatRecoveryPlan,
  sanitizeEnvironmentInfoForDisplay,
} from "../src/services/vpn-display.js";

test("formatGateway renders host and port", () => {
  assert.equal(
    formatGateway({
      host: "203.0.113.10",
      port: 9898,
    }),
    "203.0.113.10:9898",
  );
});

test("formatGateway returns placeholder for missing gateway", () => {
  assert.equal(formatGateway(null), "-");
});

test("filterGatewaysByConfigAllowlist hides gateways outside configured allowlist", () => {
  const gateways = filterGatewaysByConfigAllowlist(
    [
      { host: "203.0.113.10", port: 9000 },
      { host: "203.0.113.10", port: 9898 },
      { host: "198.51.100.20", port: 9898 },
    ],
    {
      vpn: {
        gateways: [
          { host: "203.0.113.10", port: 9898 },
          { host: "198.51.100.20", port: 9898 },
        ],
      },
    },
  );

  assert.deepEqual(gateways, [
    { host: "203.0.113.10", port: 9898 },
    { host: "198.51.100.20", port: 9898 },
  ]);
});

test("sanitizeEnvironmentInfoForDisplay filters runtime-discovered gateway candidates", () => {
  const environmentInfo = sanitizeEnvironmentInfoForDisplay(
    {
      appExecutable: "/Applications/EasyConnect.app/Contents/MacOS/EasyConnect",
      gatewayCandidates: [
        { host: "203.0.113.10", port: 9000 },
        { host: "203.0.113.10", port: 9898 },
      ],
    },
    {
      vpn: {
        gateways: [{ host: "203.0.113.10", port: 9898 }],
      },
    },
  );

  assert.deepEqual(environmentInfo.gatewayCandidates, [{ host: "203.0.113.10", port: 9898 }]);
});

test("formatAllowedGateways renders the configured allowlist", () => {
  assert.equal(
    formatAllowedGateways({
      vpn: {
        gateways: [
          { host: "203.0.113.10", port: 9898 },
          { host: "198.51.100.20", port: 9898 },
        ],
      },
    }),
    "203.0.113.10:9898\n198.51.100.20:9898",
  );
});

test("maintainer summary helpers expose action, gateway, and last error", () => {
  const status = {
    gateway: { host: "203.0.113.10", port: 9898 },
    lastError: null,
    lastEvent: {
      ok: true,
      result: {
        action: "relogin-page-bridge",
        gateway: { host: "198.51.100.20", port: 9898 },
      },
    },
  };

  assert.equal(formatMaintainerAction(status), "relogin-page-bridge");
  assert.equal(formatMaintainerGateway(status), "198.51.100.20:9898");
  assert.equal(formatMaintainerLastError(status), "-");
});

test("formatRecoveryPlan renders an ordered human-readable plan", () => {
  assert.equal(
    formatRecoveryPlan({
      gateways: [
        { host: "203.0.113.10", port: 9000, source: "configured" },
        { host: "198.51.100.20", port: 9898, source: "lastKnown" },
        { host: "203.0.113.10", port: 9898, source: "snapshot" },
      ],
      fallback: "portal-debug",
    }),
    [
      "1. 主链路 -> 203.0.113.10:9000 (手工配置)",
      "2. 主链路 -> 198.51.100.20:9898 (最近成功)",
      "3. 主链路 -> 203.0.113.10:9898 (当前快照)",
      "4. 兜底 -> portal 调试登录",
    ].join("\n"),
  );
});

test("formatRecoveryPlan handles an empty plan", () => {
  assert.equal(formatRecoveryPlan({ gateways: [], fallback: "portal-debug" }), "暂无恢复计划。");
});

test("formatGatewayProbeResults renders reachability and captcha hints", () => {
  assert.equal(
    formatGatewayProbeResults([
      {
        host: "203.0.113.10",
        port: 9000,
        source: "configured",
        reachable: true,
        captchaRequired: true,
        recommended: false,
      },
      {
        host: "198.51.100.20",
        port: 9898,
        source: "lastKnown",
        reachable: true,
        captchaRequired: false,
        recommended: true,
      },
      {
        host: "203.0.113.10",
        port: 9898,
        source: "snapshot",
        reachable: false,
        captchaRequired: null,
        recommended: false,
        error: "connect failed",
      },
    ]),
    [
      "1. 203.0.113.10:9000 | 手工配置 | 可达 | 需要验证码",
      "2. 198.51.100.20:9898 | 最近成功 | 可达 | 无验证码 | 推荐",
      "3. 203.0.113.10:9898 | 当前快照 | 不可达 | connect failed",
    ].join("\n"),
  );
});
