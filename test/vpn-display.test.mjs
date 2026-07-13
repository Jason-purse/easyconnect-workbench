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
  formatSessionId,
  sanitizeDiagnosticTextForDisplay,
  sanitizeDiagnosticValueForDisplay,
  sanitizeEnvironmentInfoForDisplay,
  sanitizeMaintainerStatusForDisplay,
  sanitizeVpnStatusForDisplay,
} from "../src/services/vpn-display.js";

test("formatSessionId masks session material for summary display", () => {
  assert.equal(formatSessionId("preview-session-7f2a"), "prev…7f2a");
  assert.equal(formatSessionId(null), "-");
});

test("sanitizeVpnStatusForDisplay allowlists status fields and redacts session ids", () => {
  const sanitized = sanitizeVpnStatusForDisplay({
    loginStatus: { status: "1", raw: "secret" },
    activeSession: {
      sessionId: "preview-session-7f2a",
      token: "derived-secret-token",
      tokenRedacted: "deri...oken",
    },
    serviceState: { base: 18, l3vpn: 18, tcp: 43, raw: "secret" },
    latestCachedToken: { token: "cached-secret-token" },
    officialUi: {
      reachable: true,
      remoteDebugPort: 9222,
      targets: [{ url: "https://gateway.example/portal/?token=secret" }],
      primaryTarget: { kind: "service", url: "https://gateway.example/portal/?token=secret" },
      hasServiceTarget: true,
      hasVisibleServiceTarget: true,
      hasBlockingVisibleTarget: false,
      hasBlockingNativeAlert: false,
      needsNativeWindowRestore: false,
      hasDuplicateNativeWindows: false,
    },
  });

  assert.deepEqual(sanitized.activeSession, { sessionId: "prev…7f2a" });
  assert.deepEqual(sanitized.loginStatus, { status: "1" });
  assert.deepEqual(sanitized.serviceState, { base: 18, l3vpn: 18, tcp: 43 });
  assert.equal(sanitized.officialUi.primaryKind, "service");
  assert.equal(JSON.stringify(sanitized).includes("preview-session-7f2a"), false);
  assert.equal(JSON.stringify(sanitized).includes("secret"), false);
  assert.equal(Object.hasOwn(sanitized, "latestCachedToken"), false);
});

test("sanitizeDiagnosticValueForDisplay recursively redacts debug URLs and session material", () => {
  const sanitized = sanitizeDiagnosticValueForDisplay({
    url: "https://gateway.example/portal/?twfid=twf-secret&token=url-secret",
    webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/socket-secret",
    sessionId: "full-session-secret",
    token: "plain-token-secret",
    nested: {
      cookie: "cookie-secret",
      error: "failed https://gateway.example/?token=error-secret",
    },
  });

  const serialized = JSON.stringify(sanitized);
  for (const secret of [
    "twf-secret",
    "url-secret",
    "socket-secret",
    "full-session-secret",
    "plain-token-secret",
    "cookie-secret",
    "error-secret",
  ]) {
    assert.equal(serialized.includes(secret), false, `${secret} must be redacted`);
  }
  assert.equal(sanitized.sessionId, "<redacted>");
  assert.equal(sanitized.token, "<redacted>");
  assert.equal(sanitized.webSocketDebuggerUrl, "<redacted>");
});

test("sanitizeDiagnosticValueForDisplay redacts credentials embedded as JSON text", () => {
  const sanitized = sanitizeDiagnosticValueForDisplay({
    error:
      'Failed {"twfid":"twf-secret","sessionId":"session-secret","token":"token-secret","webSocketDebuggerUrl":"ws://127.0.0.1/socket-secret"}',
  });
  const serialized = JSON.stringify(sanitized);

  for (const secret of ["twf-secret", "session-secret", "token-secret", "socket-secret"]) {
    assert.equal(serialized.includes(secret), false, `${secret} must be redacted`);
  }
});

test("sanitizeDiagnosticTextForDisplay redacts credentials in backslash-escaped JSON", () => {
  const secrets = {
    twfid: "escaped-twfid-privacy-case",
    sessionId: "escaped-session-privacy-case",
    token: "escaped-token-privacy-case",
    cookie: "escaped-cookie-privacy-case",
    password: "escaped-password-privacy-case",
    secret: "escaped-secret-privacy-case",
    webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/escaped-websocket-privacy-case",
  };
  const diagnostic = String.raw`\{\\\"twfid\\\":\\\"${secrets.twfid}\\\",\\\"sessionId\\\":\\\"${secrets.sessionId}\\\",\\\"token\\\":\\\"${secrets.token}\\\",\\\"cookie\\\":\\\"${secrets.cookie}\\\",\\\"password\\\":\\\"${secrets.password}\\\",\\\"secret\\\":\\\"${secrets.secret}\\\",\\\"webSocketDebuggerUrl\\\":\\\"${secrets.webSocketDebuggerUrl}\\\"\}`;
  const sanitized = sanitizeDiagnosticTextForDisplay(diagnostic);

  for (const secret of Object.values(secrets)) {
    assert.equal(sanitized.includes(secret), false, `${secret} must be redacted`);
  }
});

test("sanitizeDiagnosticTextForDisplay redacts raw DevTools WebSocket URLs", () => {
  const pageId = "raw-devtools-page-privacy-case";
  const diagnostic = `DevTools target: wss://127.0.0.1:9443/devtools/page/${pageId}`;
  const sanitized = sanitizeDiagnosticTextForDisplay(diagnostic);

  assert.equal(sanitized.includes(pageId), false);
  assert.doesNotMatch(sanitized, /wss?:\/\//i);
});

test("display status sanitizers redact credentials embedded in error strings", () => {
  const secret = "secret-session-token";
  const vpnStatus = sanitizeVpnStatusForDisplay({
    error: `failed https://gateway.example/?token=${secret}`,
  });
  const maintainerStatus = sanitizeMaintainerStatusForDisplay({
    lastError: `failed token=${secret}`,
    lastEvent: {
      ok: false,
      error: `cookie=${secret}`,
      result: {
        gatewayAttempts: [{ error: `twfid=${secret}` }],
        officialUiRepair: { error: `sessionId=${secret}` },
      },
    },
  });

  assert.equal(JSON.stringify(vpnStatus).includes(secret), false);
  assert.equal(JSON.stringify(maintainerStatus).includes(secret), false);
});

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

test("maintainer and gateway probe text formatters redact embedded credentials", () => {
  const secret = "secret-session-token";
  assert.equal(formatMaintainerLastError({ lastError: `failed token=${secret}` }).includes(secret), false);
  assert.equal(
    formatGatewayProbeResults([
      {
        host: "203.0.113.10",
        port: 9898,
        reachable: false,
        error: `failed {"sessionId":"${secret}"}`,
      },
    ]).includes(secret),
    false,
  );
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
