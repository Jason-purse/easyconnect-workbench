import { execFile } from "node:child_process";
import http from "node:http";
import https from "node:https";
import net from "node:net";

const DEFAULT_TIMEOUT_MS = 5000;
const SUPPORTED_PROTOCOLS = new Set(["tcp:", "http:", "https:"]);
const SYSTEM_DNS_LOOKUP_SCRIPT = [
  'const dns = require("node:dns");',
  'dns.lookup(process.argv[1], { all: true, verbatim: true }, (error, addresses) => {',
  '  if (error) { process.stderr.write(JSON.stringify({ code: error.code, message: error.message })); process.exitCode = 1; return; }',
  '  process.stdout.write(JSON.stringify(addresses));',
  '});',
].join("\n");

function getProbeSettings(config = {}) {
  const target = `${config?.vpn?.dataPlaneProbeTarget ?? ""}`.trim();
  const parsedTimeout = Number.parseInt(`${config?.vpn?.dataPlaneProbeTimeoutMs ?? DEFAULT_TIMEOUT_MS}`, 10);
  const timeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : DEFAULT_TIMEOUT_MS;
  return { target, timeoutMs };
}

function parseTarget(target) {
  const url = new URL(target);
  if (!SUPPORTED_PROTOCOLS.has(url.protocol)) {
    throw new Error(`Unsupported probe protocol: ${url.protocol || "unknown"}`);
  }
  if (!url.hostname) {
    throw new Error("Probe target requires a host");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Probe target must not contain credentials, query parameters, or fragments");
  }
  if (url.protocol === "tcp:" && (!url.port || (url.pathname && url.pathname !== "/"))) {
    throw new Error("TCP probe target requires an explicit port and no path");
  }

  const publicTarget = url.protocol === "tcp:"
    ? `tcp://${url.host}`
    : url.origin;
  return {
    url,
    target: publicTarget,
    host: url.hostname.replace(/^\[|\]$/g, ""),
    port: Number.parseInt(url.port || (url.protocol === "https:" ? "443" : "80"), 10),
    protocol: url.protocol,
  };
}

function createAbortError() {
  const error = new Error("VPN data-plane probe aborted");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

function createTimeoutError(timeoutMs) {
  const error = new Error(`VPN data-plane probe timed out after ${timeoutMs}ms`);
  error.name = "TimeoutError";
  error.code = "ETIMEDOUT";
  return error;
}

function getSignalReason(signal) {
  return signal?.reason instanceof Error ? signal.reason : createAbortError();
}

function createProbeDeadline(timeoutMs, parentSignal) {
  const controller = new AbortController();
  let timedOut = false;
  let timer = null;

  const abortFromParent = () => {
    if (!controller.signal.aborted) {
      controller.abort(getSignalReason(parentSignal));
    }
  };

  if (parentSignal?.aborted) {
    abortFromParent();
  } else {
    parentSignal?.addEventListener?.("abort", abortFromParent, { once: true });
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort(createTimeoutError(timeoutMs));
    }, timeoutMs);
  }

  return {
    signal: controller.signal,
    didTimeOut: () => timedOut,
    cleanup() {
      if (timer) {
        clearTimeout(timer);
      }
      parentSignal?.removeEventListener?.("abort", abortFromParent);
    },
  };
}

function runAbortable(operation, signal) {
  if (signal?.aborted) {
    return Promise.reject(getSignalReason(signal));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (handler, value) => {
      if (settled) {
        return;
      }
      settled = true;
      signal?.removeEventListener?.("abort", abort);
      handler(value);
    };
    const abort = () => finish(reject, getSignalReason(signal));

    signal?.addEventListener?.("abort", abort, { once: true });
    Promise.resolve()
      .then(operation)
      .then(
        (value) => finish(resolve, value),
        (error) => finish(reject, error),
      );
  });
}

export function resolveHost(host, options = {}) {
  return new Promise((resolve, reject) => {
    const execFileFn = options.execFileFn ?? execFile;
    execFileFn(
      options.execPath ?? process.execPath,
      ["-e", SYSTEM_DNS_LOOKUP_SCRIPT, host],
      {
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: 64 * 1024,
        ...(options.signal ? { signal: options.signal } : {}),
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "1",
        },
      },
      (error, stdout, stderr) => {
        if (error) {
          if (error.name !== "AbortError") {
            try {
              const diagnostic = JSON.parse(`${stderr ?? ""}`);
              error.code = diagnostic.code ?? error.code;
              error.message = diagnostic.message ?? error.message;
            } catch {
              // Preserve the executable error when the worker emitted no JSON diagnostic.
            }
          }
          reject(error);
          return;
        }

        try {
          const addresses = JSON.parse(`${stdout ?? "[]"}`);
          if (!Array.isArray(addresses) || addresses.length === 0) {
            const missing = new Error("DNS lookup did not return an IP address");
            missing.code = "DNS_ADDRESS_MISSING";
            reject(missing);
            return;
          }
          resolve(addresses);
        } catch (parseError) {
          parseError.code = "DNS_RESPONSE_INVALID";
          reject(parseError);
        }
      },
    );
  });
}

function normalizeResolvedAddress(value) {
  const candidate = Array.isArray(value) ? value[0] : value;
  const address = `${candidate?.address ?? candidate ?? ""}`.trim();
  const family = Number(candidate?.family ?? net.isIP(address));
  if (!address || !net.isIP(address)) {
    const error = new Error("DNS lookup did not return an IP address");
    error.code = "DNS_ADDRESS_MISSING";
    throw error;
  }

  return { address, family };
}

function sanitizeError(error) {
  const message = `${error?.message ?? error ?? "Probe failed"}`;
  return error?.code && !message.includes(`${error.code}`)
    ? `${error.code}: ${message}`
    : message;
}

function normalizeRoute(route = {}) {
  const interfaceName = `${route.interface ?? ""}`.trim() || null;
  const gateway = `${route.gateway ?? ""}`.trim() || null;
  return {
    interface: interfaceName,
    gateway,
    tunneled: /^utun\d+$/i.test(interfaceName ?? ""),
  };
}

export function lookupRoute(host, timeoutMs, options = {}) {
  return new Promise((resolve, reject) => {
    try {
      const execFileFn = options.execFileFn ?? execFile;
      const args = net.isIP(host) === 6
        ? ["-n", "get", "-inet6", host]
        : ["-n", "get", host];
      execFileFn(
        "/sbin/route",
        args,
        {
          timeout: timeoutMs,
          maxBuffer: 64 * 1024,
          ...(options.signal ? { signal: options.signal } : {}),
        },
        (error, stdout) => {
          if (error) {
            reject(error);
            return;
          }

          const interfaceName = /^\s*interface:\s*(\S+)/im.exec(stdout)?.[1] ?? null;
          const gateway = /^\s*gateway:\s*(\S+)/im.exec(stdout)?.[1] ?? null;
          if (!interfaceName) {
            const routeError = new Error(`No interface found for route to ${host}`);
            routeError.code = "ROUTE_INTERFACE_MISSING";
            reject(routeError);
            return;
          }
          resolve({ interface: interfaceName, gateway });
        },
      );
    } catch (error) {
      reject(error);
    }
  });
}

function connectTcp({ host, port, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let settled = false;

    const finish = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      signal?.removeEventListener?.("abort", abort);
      socket.destroy();
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };

    const abort = () => finish(getSignalReason(signal));

    socket.setTimeout(timeoutMs, () => {
      const error = new Error(`TCP probe timed out after ${timeoutMs}ms`);
      error.code = "ETIMEDOUT";
      finish(error);
    });
    socket.once("connect", () => finish());
    socket.once("error", finish);
    if (signal?.aborted) {
      abort();
    } else {
      signal?.addEventListener?.("abort", abort, { once: true });
    }
  });
}

function requestHttp({ url, address, family, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const request = transport.request(
      url,
      {
        method: "GET",
        ...(signal ? { signal } : {}),
        lookup(_hostname, lookupOptions, callback) {
          if (lookupOptions?.all) {
            callback(null, [{ address, family }]);
            return;
          }
          callback(null, address, family);
        },
        headers: {
          accept: "*/*",
          "user-agent": "EasyConnect-Workbench/0.1",
        },
      },
      (response) => {
        const statusCode = response.statusCode ?? null;
        response.resume();
        resolve({ statusCode });
        response.destroy();
      },
    );
    request.setTimeout(timeoutMs, () => {
      const error = new Error(`HTTP probe timed out after ${timeoutMs}ms`);
      error.code = "ETIMEDOUT";
      request.destroy(error);
    });
    request.once("error", reject);
    request.end();
  });
}

export function describeVpnDataPlaneProbe(config = {}, state = "unconfigured") {
  const { target } = getProbeSettings(config);
  if (!target) {
    return {
      configured: false,
      ok: null,
      state: "unconfigured",
      target: null,
    };
  }

  let parsed = null;
  try {
    parsed = parseTarget(target);
  } catch {
    return {
      configured: true,
      ok: false,
      state: "invalid-target",
      target: null,
      code: "VPN_DATA_PLANE_INVALID_TARGET",
      error: "Invalid data-plane probe target",
    };
  }

  return {
    configured: true,
    ok: null,
    state,
    target: parsed.target,
  };
}

export async function probeVpnDataPlane(config = {}, options = {}) {
  const { target, timeoutMs } = getProbeSettings(config);
  if (!target) {
    return describeVpnDataPlaneProbe(config);
  }

  let parsed = null;
  try {
    parsed = parseTarget(target);
  } catch (error) {
    return {
      configured: true,
      ok: false,
      state: "invalid-target",
      target: null,
      code: "VPN_DATA_PLANE_INVALID_TARGET",
      error: "Invalid data-plane probe target",
    };
  }

  const nowFn = options.nowFn ?? (() => Date.now());
  const resolveHostFn = options.resolveHostFn ?? resolveHost;
  const routeLookupFn = options.routeLookupFn ?? lookupRoute;
  const tcpConnectFn = options.tcpConnectFn ?? connectTcp;
  const httpRequestFn = options.httpRequestFn ?? requestHttp;
  const startedAt = nowFn();
  const completeProbe = (result) => {
    const completedAt = nowFn();
    return {
      ...result,
      observedAt: new Date(completedAt).toISOString(),
      durationMs: Math.max(0, completedAt - startedAt),
    };
  };
  const deadline = createProbeDeadline(timeoutMs, options.signal);
  const signal = deadline.signal;
  let phase = "resolve";
  let route = null;

  try {
    const resolved = net.isIP(parsed.host)
      ? { address: parsed.host, family: net.isIP(parsed.host) }
      : normalizeResolvedAddress(await runAbortable(
          () => resolveHostFn(parsed.host, { signal, timeoutMs }),
          signal,
        ));

    phase = "route";
    route = normalizeRoute(await runAbortable(
      () => routeLookupFn(resolved.address, timeoutMs, { signal }),
      signal,
    ));

    if (!route.tunneled) {
      return completeProbe({
        configured: true,
        ok: false,
        state: "not-tunneled",
        target: parsed.target,
        protocol: parsed.protocol,
        route,
        code: "VPN_DATA_PLANE_ROUTE_NOT_TUNNELED",
        error: `Probe target is routed through ${route.interface ?? "an unknown interface"}, not utun`,
      });
    }

    phase = "connect";
    if (parsed.protocol === "tcp:") {
      await runAbortable(
        () => tcpConnectFn({
          host: resolved.address,
          port: parsed.port,
          timeoutMs,
          signal,
        }),
        signal,
      );
      return completeProbe({
        configured: true,
        ok: true,
        state: "reachable",
        target: parsed.target,
        protocol: parsed.protocol,
        route,
      });
    }

    const response = await runAbortable(
      () => httpRequestFn({
        url: parsed.url,
        address: resolved.address,
        family: resolved.family,
        timeoutMs,
        signal,
      }),
      signal,
    );
    const statusCode = Number(response?.statusCode ?? 0);
    const ok = statusCode >= 200 && statusCode < 400;
    return completeProbe({
      configured: true,
      ok,
      state: ok ? "reachable" : "unexpected-status",
      target: parsed.target,
      protocol: parsed.protocol,
      route,
      statusCode,
      ...(ok
        ? {}
        : {
            code: "VPN_DATA_PLANE_UNEXPECTED_STATUS",
            error: `Probe returned HTTP ${statusCode || "unknown"}`,
          }),
    });
  } catch (error) {
    if (options.signal?.aborted) {
      throw getSignalReason(options.signal);
    }

    if (deadline.didTimeOut()) {
      return completeProbe({
        configured: true,
        ok: false,
        state: "timeout",
        target: parsed.target,
        protocol: parsed.protocol,
        ...(route ? { route } : {}),
        code: "VPN_DATA_PLANE_TIMEOUT",
        causeCode: "ETIMEDOUT",
        error: `Probe timed out after ${timeoutMs}ms`,
      });
    }

    if (phase === "connect") {
      return completeProbe({
        configured: true,
        ok: false,
        state: "unreachable",
        target: parsed.target,
        protocol: parsed.protocol,
        route,
        code: "VPN_DATA_PLANE_UNREACHABLE",
        causeCode: error?.code ?? null,
        error: parsed.protocol === "tcp:"
          ? sanitizeError(error)
          : `${error?.code ? `${error.code}: ` : ""}HTTP probe request failed`,
      });
    }

    if (phase === "resolve") {
      return completeProbe({
        configured: true,
        ok: false,
        state: "dns-unavailable",
        target: parsed.target,
        protocol: parsed.protocol,
        code: "VPN_DATA_PLANE_DNS_LOOKUP_FAILED",
        causeCode: error?.code ?? null,
        error: sanitizeError(error),
      });
    }

    return completeProbe({
      configured: true,
      ok: false,
      state: "route-unavailable",
      target: parsed.target,
      protocol: parsed.protocol,
      code: "VPN_DATA_PLANE_ROUTE_LOOKUP_FAILED",
      causeCode: error?.code ?? null,
      error: sanitizeError(error),
    });
  } finally {
    deadline.cleanup();
  }
}
