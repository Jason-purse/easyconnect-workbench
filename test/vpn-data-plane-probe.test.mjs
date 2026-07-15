import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import {
  describeVpnDataPlaneProbe,
  lookupRoute,
  probeVpnDataPlane,
  resolveHost,
} from "../src/services/vpn-data-plane-probe.js";

function probeConfig(target, timeoutMs = 5000) {
  return {
    vpn: {
      dataPlaneProbeTarget: target,
      dataPlaneProbeTimeoutMs: timeoutMs,
    },
  };
}

test("probeVpnDataPlane reports an unconfigured target without network IO", async () => {
  let routeCalls = 0;
  const result = await probeVpnDataPlane({}, {
    routeLookupFn: async () => {
      routeCalls += 1;
      return { interface: "utun5" };
    },
  });

  assert.deepEqual(result, {
    configured: false,
    ok: null,
    state: "unconfigured",
    target: null,
  });
  assert.equal(routeCalls, 0);
});

test("probeVpnDataPlane rejects a route that bypasses the VPN tunnel", async () => {
  let connectCalls = 0;
  const result = await probeVpnDataPlane(probeConfig("tcp://192.168.150.199:1521"), {
    routeLookupFn: async () => ({ interface: "en0", gateway: "192.168.1.1" }),
    tcpConnectFn: async () => {
      connectCalls += 1;
    },
  });

  assert.equal(result.configured, true);
  assert.equal(result.ok, false);
  assert.equal(result.state, "not-tunneled");
  assert.equal(result.code, "VPN_DATA_PLANE_ROUTE_NOT_TUNNELED");
  assert.deepEqual(result.route, {
    interface: "en0",
    gateway: "192.168.1.1",
    tunneled: false,
  });
  assert.equal(connectCalls, 0);
});

test("probeVpnDataPlane verifies a TCP endpoint routed through utun", async () => {
  const calls = [];
  const timestamps = [1000, 1037];
  const result = await probeVpnDataPlane(probeConfig("tcp://192.168.150.199:1521", 2400), {
    nowFn: () => timestamps.shift(),
    routeLookupFn: async (host, timeoutMs) => {
      calls.push(["route", host, timeoutMs]);
      return { interface: "utun5", gateway: "2.0.1.18" };
    },
    tcpConnectFn: async (options) => {
      calls.push([
        "tcp",
        {
          host: options.host,
          port: options.port,
          timeoutMs: options.timeoutMs,
          signal: Boolean(options.signal),
        },
      ]);
    },
  });

  assert.deepEqual(calls, [
    ["route", "192.168.150.199", 2400],
    ["tcp", { host: "192.168.150.199", port: 1521, timeoutMs: 2400, signal: true }],
  ]);
  assert.deepEqual(result, {
    configured: true,
    ok: true,
    state: "reachable",
    target: "tcp://192.168.150.199:1521",
    protocol: "tcp:",
    observedAt: "1970-01-01T00:00:01.037Z",
    durationMs: 37,
    route: {
      interface: "utun5",
      gateway: "2.0.1.18",
      tunneled: true,
    },
  });
});

test("probeVpnDataPlane resolves a hostname once and binds route and TCP checks to that address", async () => {
  const calls = [];
  const result = await probeVpnDataPlane(probeConfig("tcp://db.internal.example:1521"), {
    resolveHostFn: async (host, options) => {
      calls.push(["resolve", host, Boolean(options.signal)]);
      return { address: "192.0.2.44", family: 4 };
    },
    routeLookupFn: async (host, timeoutMs, options) => {
      calls.push(["route", host, timeoutMs, Boolean(options.signal)]);
      return { interface: "utun5", gateway: "2.0.1.18" };
    },
    tcpConnectFn: async (options) => {
      calls.push(["tcp", options.host, options.port, Boolean(options.signal)]);
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    ["resolve", "db.internal.example", true],
    ["route", "192.0.2.44", 5000, true],
    ["tcp", "192.0.2.44", 1521, true],
  ]);
});

test("probeVpnDataPlane enforces one total deadline even when DNS never settles", async () => {
  const startedAt = Date.now();
  const result = await probeVpnDataPlane(probeConfig("tcp://db.internal.example:1521", 30), {
    resolveHostFn: async () => new Promise(() => {}),
  });

  assert.equal(result.ok, false);
  assert.equal(result.state, "timeout");
  assert.equal(result.code, "VPN_DATA_PLANE_TIMEOUT");
  assert.ok(Date.now() - startedAt < 500, "the total deadline must include DNS resolution");
});

test("probeVpnDataPlane stops promptly when its caller aborts", async () => {
  const controller = new AbortController();
  const pending = probeVpnDataPlane(probeConfig("tcp://db.internal.example:1521", 5000), {
    signal: controller.signal,
    resolveHostFn: async () => new Promise(() => {}),
  });

  controller.abort();
  await assert.rejects(pending, (error) => error?.name === "AbortError");
});

test("resolveHost runs system lookup in an abortable worker", async () => {
  const controller = new AbortController();
  let invocation = null;
  const pending = resolveHost("db.internal.example", {
    signal: controller.signal,
    timeoutMs: 2400,
    execFileFn(file, args, options, callback) {
      invocation = { file, args, options };
      options.signal.addEventListener("abort", () => {
        const error = new Error("lookup worker aborted");
        error.name = "AbortError";
        error.code = "ABORT_ERR";
        callback(error, "", "");
      }, { once: true });
    },
  });

  controller.abort();
  await assert.rejects(pending, (error) => error?.name === "AbortError");
  assert.equal(invocation.file, process.execPath);
  assert.match(invocation.args[1], /dns\.lookup/);
  assert.equal(invocation.args.at(-1), "db.internal.example");
  assert.equal(invocation.options.timeout, 2400);
  assert.equal(invocation.options.env.ELECTRON_RUN_AS_NODE, "1");
});

test("resolveHost returns addresses from the macOS system lookup worker", async () => {
  const result = await resolveHost("hosts-only.internal", {
    execFileFn(_file, _args, _options, callback) {
      callback(null, JSON.stringify([
        { address: "172.16.1.176", family: 4 },
        { address: "fd00::176", family: 6 },
      ]), "");
    },
  });

  assert.deepEqual(result, [
    { address: "172.16.1.176", family: 4 },
    { address: "fd00::176", family: 6 },
  ]);
});

test("lookupRoute selects the macOS IPv6 address family", async () => {
  let invocation = null;
  const route = await lookupRoute("2001:db8::44", 2400, {
    execFileFn(file, args, options, callback) {
      invocation = { file, args, options };
      callback(null, "   gateway: 2::1\n interface: utun7\n");
    },
  });

  assert.equal(invocation.file, "/sbin/route");
  assert.deepEqual(invocation.args, ["-n", "get", "-inet6", "2001:db8::44"]);
  assert.equal(invocation.options.timeout, 2400);
  assert.deepEqual(route, { interface: "utun7", gateway: "2::1" });
});

test("probeVpnDataPlane classifies DNS failures separately from route failures", async () => {
  const result = await probeVpnDataPlane(probeConfig("tcp://missing.internal.example:1521"), {
    resolveHostFn: async () => {
      const error = new Error("query ENOTFOUND missing.internal.example");
      error.code = "ENOTFOUND";
      throw error;
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.state, "dns-unavailable");
  assert.equal(result.code, "VPN_DATA_PLANE_DNS_LOOKUP_FAILED");
  assert.equal(result.causeCode, "ENOTFOUND");
});

test("probeVpnDataPlane reports a failed TCP connection without throwing", async () => {
  const result = await probeVpnDataPlane(probeConfig("tcp://192.168.150.199:1521"), {
    routeLookupFn: async () => ({ interface: "utun5" }),
    tcpConnectFn: async () => {
      const error = new Error("connect ETIMEDOUT 192.168.150.199:1521");
      error.code = "ETIMEDOUT";
      throw error;
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.state, "unreachable");
  assert.equal(result.code, "VPN_DATA_PLANE_UNREACHABLE");
  assert.equal(result.causeCode, "ETIMEDOUT");
  assert.match(result.error, /ETIMEDOUT/);
});

test("probeVpnDataPlane accepts HTTP 2xx and 3xx responses through utun", async () => {
  for (const statusCode of [204, 302]) {
    const result = await probeVpnDataPlane(probeConfig("https://intranet.example/health"), {
      resolveHostFn: async () => ({ address: "192.0.2.45", family: 4 }),
      routeLookupFn: async () => ({ interface: "utun2" }),
      httpRequestFn: async ({ url, address, family, timeoutMs, signal }) => {
        assert.equal(url.href, "https://intranet.example/health");
        assert.equal(address, "192.0.2.45");
        assert.equal(family, 4);
        assert.equal(timeoutMs, 5000);
        assert.equal(Boolean(signal), true);
        return { statusCode };
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.statusCode, statusCode);
    assert.equal(result.state, "reachable");
  }
});

test("probeVpnDataPlane keeps the HTTP Host header while connecting the route-checked address", async () => {
  let receivedHost = null;
  let receivedPath = null;
  const server = createServer((request, response) => {
    receivedHost = request.headers.host;
    receivedPath = request.url;
    response.writeHead(204);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    const target = `http://probe.internal:${address.port}/health`;
    const result = await probeVpnDataPlane(probeConfig(target), {
      resolveHostFn: async () => ({ address: "127.0.0.1", family: 4 }),
      routeLookupFn: async (host) => {
        assert.equal(host, "127.0.0.1");
        return { interface: "utun2" };
      },
    });

    assert.equal(result.ok, true);
    assert.equal(receivedHost, `probe.internal:${address.port}`);
    assert.equal(receivedPath, "/health");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("probeVpnDataPlane completes from HTTP headers without waiting for a streaming body", async () => {
  const sockets = new Set();
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.write("reachable");
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    const result = await probeVpnDataPlane(probeConfig(`http://127.0.0.1:${address.port}/health`, 100), {
      routeLookupFn: async () => ({ interface: "utun2" }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.statusCode, 200);
  } finally {
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise((resolve) => server.close(resolve));
  }
});

test("probeVpnDataPlane rejects an HTTP error response and credentialed targets", async () => {
  const unavailable = await probeVpnDataPlane(probeConfig("http://intranet.example/health"), {
    resolveHostFn: async () => ({ address: "192.0.2.45", family: 4 }),
    routeLookupFn: async () => ({ interface: "utun2" }),
    httpRequestFn: async () => ({ statusCode: 503 }),
  });
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.state, "unexpected-status");
  assert.equal(unavailable.statusCode, 503);
  assert.equal(unavailable.code, "VPN_DATA_PLANE_UNEXPECTED_STATUS");

  const invalid = await probeVpnDataPlane(probeConfig("https://user:secret@intranet.example/health"));
  assert.equal(invalid.ok, false);
  assert.equal(invalid.state, "invalid-target");
  assert.equal(invalid.code, "VPN_DATA_PLANE_INVALID_TARGET");
  assert.equal(JSON.stringify(invalid).includes("secret"), false);
});

test("probeVpnDataPlane never exposes an HTTP path in diagnostics", async () => {
  const result = await probeVpnDataPlane(
    probeConfig("https://intranet.example/private/token-value"),
    {
      resolveHostFn: async () => ({ address: "192.0.2.45", family: 4 }),
      routeLookupFn: async () => ({ interface: "utun2" }),
      httpRequestFn: async () => {
        const error = new Error("GET /private/token-value failed");
        error.code = "ECONNRESET";
        throw error;
      },
    },
  );

  assert.equal(result.target, "https://intranet.example");
  assert.equal(result.causeCode, "ECONNRESET");
  assert.equal(JSON.stringify(result).includes("private/token-value"), false);
  assert.equal(JSON.stringify(result).includes("token-value"), false);
});

test("describeVpnDataPlaneProbe never exposes credentials from an invalid offline target", () => {
  const state = describeVpnDataPlaneProbe(
    probeConfig("https://user:secret@intranet.example/health"),
    "control-plane-offline",
  );

  assert.equal(state.configured, true);
  assert.equal(state.ok, false);
  assert.equal(state.state, "invalid-target");
  assert.equal(state.target, null);
  assert.equal(JSON.stringify(state).includes("secret"), false);
});
