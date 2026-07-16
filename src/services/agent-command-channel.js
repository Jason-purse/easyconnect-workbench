import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdir, unlink } from "node:fs/promises";

import {
  sanitizeDiagnosticTextForDisplay,
  sanitizeDiagnosticValueForDisplay,
} from "./vpn-display.js";

const DEFAULT_MAX_REQUEST_BYTES = 64 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_MAX_CONNECTIONS = 32;
const DEFAULT_REQUEST_TIMEOUT_MS = 5000;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const SOCKET_PROBE_TIMEOUT_MS = 500;
const SOCKET_LOCK_TIMEOUT_SECONDS = 5;
const LOCKF_TEMPORARY_FAILURE_EXIT = 75;
const SHUTDOWN_REQUEST_DRAIN_MS = 250;
const SHUTDOWN_RESPONSE_DRAIN_MS = 250;
const AUTHORITATIVE_RESULT_COMMANDS = new Set([
  "ensure",
  "keepalive-start",
  "keepalive-stop",
]);
const PUBLIC_ERROR_FIELDS = [
  "activeKey",
  "dataPlane",
  "quietHours",
  "reason",
  "requestedKey",
  "status",
];

function createProtocolError(message, code = "EASYCONNECT_AGENT_PROTOCOL_INVALID") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function markTransportError(error) {
  if (error && typeof error === "object") {
    error.agentTransport = true;
    return error;
  }
  const transportError = new Error(String(error));
  transportError.code = "EASYCONNECT_AGENT_TRANSPORT_UNAVAILABLE";
  transportError.agentTransport = true;
  return transportError;
}

function cloneJson(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return undefined;
  }
}

function readPropertySafely(value, key) {
  try {
    return { ok: true, value: value?.[key] };
  } catch {
    return { ok: false, value: undefined };
  }
}

function getSerializedErrorMessage(error) {
  const message = readPropertySafely(error, "message");
  if (!message.ok) {
    return "EasyConnect agent command failed";
  }

  let candidate = message.value;
  if (candidate === undefined) {
    try {
      candidate = String(error);
    } catch {
      return "EasyConnect agent command failed";
    }
  }
  try {
    const sanitized = sanitizeDiagnosticTextForDisplay(candidate);
    return typeof sanitized === "string" && sanitized.trim()
      ? sanitized
      : "EasyConnect agent command failed";
  } catch {
    return "EasyConnect agent command failed";
  }
}

function serializeError(error) {
  const codeField = readPropertySafely(error, "code");
  const rawCode = codeField.ok ? codeField.value : undefined;
  const code = typeof rawCode === "string"
    ? rawCode.trim() || "EASYCONNECT_AGENT_COMMAND_FAILED"
    : Number.isFinite(rawCode)
      ? String(rawCode)
      : "EASYCONNECT_AGENT_COMMAND_FAILED";
  const serialized = {
    message: getSerializedErrorMessage(error),
    code,
  };

  for (const field of PUBLIC_ERROR_FIELDS) {
    const detail = readPropertySafely(error, field);
    if (!detail.ok || detail.value === undefined) {
      continue;
    }
    try {
      const value = cloneJson(sanitizeDiagnosticValueForDisplay(detail.value, field));
      if (value !== undefined) {
        serialized[field] = value;
      }
    } catch {
      // Omit malformed diagnostic fields while preserving the bounded error envelope.
    }
  }

  return serialized;
}

function validateRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw createProtocolError("Agent command request must be a JSON object");
  }

  const command = `${value.command ?? ""}`.trim();
  if (!command) {
    throw createProtocolError("Agent command request requires a command");
  }

  const options = value.options ?? {};
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw createProtocolError("Agent command options must be a JSON object");
  }

  return { command, options };
}

async function removeSocket(socketPath) {
  try {
    await unlink(socketPath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

async function getSocketPathEntry(socketPath) {
  try {
    return await lstat(socketPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function createSocketLockError(socketPath, outcome) {
  if (outcome?.code === LOCKF_TEMPORARY_FAILURE_EXIT) {
    return createProtocolError(
      `Timed out waiting for the EasyConnect agent socket lock: ${socketPath}`,
      "EASYCONNECT_AGENT_SOCKET_LOCK_TIMEOUT",
    );
  }
  const detail = outcome?.error?.message ?? (
    outcome?.signal
      ? `lockf exited on ${outcome.signal}`
      : `lockf exited ${outcome?.code ?? "before acquisition"}`
  );
  const error = createProtocolError(
    `Could not acquire the EasyConnect agent socket lock: ${detail}`,
    "EASYCONNECT_AGENT_SOCKET_LOCK_FAILED",
  );
  error.causeCode = outcome?.error?.code;
  return error;
}

async function acquireSocketPathLock(
  socketPath,
  {
    spawnFn = spawn,
    timeoutSeconds = SOCKET_LOCK_TIMEOUT_SECONDS,
  } = {},
) {
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 0) {
    throw new Error("socket lock timeoutSeconds must be a non-negative integer");
  }

  const lockPath = `${socketPath}.lock`;
  const token = `${randomUUID()}\n`;
  let child;
  try {
    child = spawnFn(
      "/usr/bin/lockf",
      ["-k", "-s", "-w", "-t", `${timeoutSeconds}`, lockPath, "/bin/cat"],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
  } catch (error) {
    throw createSocketLockError(socketPath, { error });
  }

  let stderr = "";
  child.stderr?.setEncoding?.("utf8");
  child.stderr?.on?.("data", (chunk) => {
    if (stderr.length < 4096) {
      stderr += `${chunk}`;
    }
  });
  child.stdin?.on?.("error", () => {});

  const exitPromise = new Promise((resolve) => {
    child.once("error", (error) => resolve({ error }));
    child.once("exit", (code, signal) => resolve({ code, signal, stderr }));
  });
  const acquiredPromise = new Promise((resolve, reject) => {
    let stdout = "";
    child.stdout?.setEncoding?.("utf8");
    const onData = (chunk) => {
      stdout += `${chunk}`;
      if (stdout.includes(token)) {
        child.stdout?.off?.("data", onData);
        resolve();
        return;
      }
      if (stdout.length > token.length * 2) {
        child.stdout?.off?.("data", onData);
        reject(
          createProtocolError(
            "EasyConnect agent socket lock returned an invalid acquisition handshake",
            "EASYCONNECT_AGENT_SOCKET_LOCK_FAILED",
          ),
        );
      }
    };
    child.stdout?.on?.("data", onData);
    child.stdin?.write?.(token, (error) => {
      if (error) {
        child.stdout?.off?.("data", onData);
        void exitPromise.then((outcome) => {
          reject(createSocketLockError(socketPath, outcome?.code === undefined ? { error } : outcome));
        });
      }
    });
  });

  const outcome = await Promise.race([
    acquiredPromise.then(() => null),
    exitPromise,
  ]).catch((error) => {
    child.kill?.("SIGTERM");
    throw error;
  });
  if (outcome) {
    throw createSocketLockError(socketPath, outcome);
  }

  return { child, exitPromise, lockPath, socketPath };
}

async function releaseSocketPathLock(holder) {
  holder.child.stdin?.end?.();
  const outcome = await holder.exitPromise;
  if (outcome?.error || outcome?.code !== 0) {
    throw createSocketLockError(holder.socketPath, outcome);
  }
}

export async function withSocketPathLock(socketPath, callback, options = {}) {
  if (!socketPath) {
    throw new Error("withSocketPathLock requires socketPath");
  }
  if (typeof callback !== "function") {
    throw new Error("withSocketPathLock requires callback");
  }

  const holder = await acquireSocketPathLock(socketPath, options);
  let callbackError = null;
  try {
    await chmod(holder.lockPath, 0o600);
    return await callback();
  } catch (error) {
    callbackError = error;
    throw error;
  } finally {
    try {
      await releaseSocketPathLock(holder);
    } catch (error) {
      if (!callbackError) {
        throw error;
      }
      callbackError.lockReleaseError = {
        code: error?.code,
        message: error?.message ?? String(error),
      };
    }
  }
}

function probeLiveSocket(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    const timer = setTimeout(() => finish(resolve, true), SOCKET_PROBE_TIMEOUT_MS);
    timer.unref?.();

    function finish(handler, value) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      handler(value);
    }

    socket.once("connect", () => finish(resolve, true));
    socket.once("error", (error) => {
      if (["ECONNREFUSED", "ENOENT"].includes(error?.code)) {
        finish(resolve, false);
        return;
      }
      finish(reject, error);
    });
  });
}

export async function prepareSocketPath(
  socketPath,
  {
    getEntryFn = getSocketPathEntry,
    probeSocketFn = probeLiveSocket,
    removeSocketFn = removeSocket,
  } = {},
) {
  while (true) {
    const existing = await getEntryFn(socketPath);
    if (!existing) {
      return;
    }
    if (!existing.isSocket()) {
      throw createProtocolError(
        `Refusing to replace non-socket agent path: ${socketPath}`,
        "EASYCONNECT_AGENT_SOCKET_PATH_CONFLICT",
      );
    }
    if (await probeSocketFn(socketPath)) {
      throw createProtocolError(
        `Another EasyConnect Workbench command server owns ${socketPath}`,
        "EASYCONNECT_AGENT_SOCKET_IN_USE",
      );
    }

    const current = await getEntryFn(socketPath);
    if (!current) {
      return;
    }
    if (!hasFileIdentity(current, getFileIdentity(existing))) {
      continue;
    }
    await removeSocketFn(socketPath);
    return;
  }
}

function writeEnvelope(socket, envelope) {
  if (socket.destroyed) {
    return Promise.resolve();
  }
  let serialized;
  try {
    serialized = JSON.stringify(envelope);
  } catch {
    serialized = JSON.stringify({
      ok: false,
      error: serializeError(
        createProtocolError(
          "EasyConnect agent command result could not be serialized",
          "EASYCONNECT_AGENT_RESPONSE_INVALID",
        ),
      ),
    });
  }
  return new Promise((resolve, reject) => {
    const finish = () => {
      socket.off("close", finish);
      socket.off("error", fail);
      socket.destroy();
      resolve();
    };
    const fail = (error) => {
      socket.off("close", finish);
      socket.off("error", fail);
      reject(error);
    };
    socket.once("close", finish);
    socket.once("error", fail);
    socket.end(`${serialized}\n`, finish);
  });
}

function getFileIdentity(entry) {
  return entry ? { dev: entry.dev, ino: entry.ino } : null;
}

function hasFileIdentity(entry, identity) {
  return Boolean(entry && identity && entry.dev === identity.dev && entry.ino === identity.ino);
}

async function preserveReboundSocketPath(socketPath, ownedIdentity) {
  const current = await getSocketPathEntry(socketPath);
  if (!current || hasFileIdentity(current, ownedIdentity)) {
    return null;
  }
  const preservedPath = `${socketPath}.preserved-${process.pid}-${randomUUID()}`;
  await link(socketPath, preservedPath);
  return {
    path: preservedPath,
    identity: getFileIdentity(current),
  };
}

export async function restoreReboundSocketPath(
  socketPath,
  preserved,
  logger,
  { linkFn = link } = {},
) {
  if (!preserved) {
    return;
  }
  while (true) {
    try {
      await linkFn(preserved.path, socketPath);
      await removeSocket(preserved.path);
      return;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      const current = await getSocketPathEntry(socketPath);
      if (!current) {
        continue;
      }
      if (hasFileIdentity(current, preserved.identity)) {
        await removeSocket(preserved.path);
        return;
      }
      logger?.warn?.(`Agent socket path changed again while stopping; discarded unreachable successor alias ${preserved.path}`);
      await removeSocket(preserved.path);
      return;
    }
  }
}

export function getAgentSocketPath(userDataPath) {
  if (!userDataPath) {
    throw new Error("getAgentSocketPath requires userDataPath");
  }
  return path.join(userDataPath, "agent.sock");
}

export function createRetryableAgentCommandServerStarter({ createServer } = {}) {
  if (typeof createServer !== "function") {
    throw new Error("createRetryableAgentCommandServerStarter requires createServer");
  }

  let server = null;
  let started = false;
  let startPromise = null;

  function getServer() {
    if (!server) {
      server = createServer();
      if (
        !server ||
        typeof server.start !== "function" ||
        typeof server.stop !== "function" ||
        typeof server.stopAccepting !== "function"
      ) {
        throw new Error("createServer must return an agent command server");
      }
    }
    return server;
  }

  function start() {
    if (started) {
      return Promise.resolve(server);
    }
    if (startPromise) {
      return startPromise;
    }

    let current;
    try {
      current = getServer();
    } catch (error) {
      return Promise.reject(error);
    }
    const attempt = Promise.resolve()
      .then(() => current.start())
      .then(() => {
        started = true;
        return current;
      });
    const tracked = attempt.finally(() => {
      if (startPromise === tracked) {
        startPromise = null;
      }
    });
    startPromise = tracked;
    return tracked;
  }

  function stopAccepting() {
    server?.stopAccepting();
  }

  function stop() {
    started = false;
    return Promise.resolve()
      .then(() => server?.stop())
      .finally(() => {
        started = false;
      });
  }

  return {
    start,
    stop,
    stopAccepting,
    get server() {
      return server;
    },
  };
}

export function createAgentCommandServer({
  socketPath,
  handleRequest,
  maxRequestBytes = DEFAULT_MAX_REQUEST_BYTES,
  maxConnections = DEFAULT_MAX_CONNECTIONS,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  createServerFn = (connectionHandler) => net.createServer(connectionHandler),
  withSocketPathLockFn = withSocketPathLock,
  logger = console,
} = {}) {
  if (!socketPath) {
    throw new Error("createAgentCommandServer requires socketPath");
  }
  if (typeof handleRequest !== "function") {
    throw new Error("createAgentCommandServer requires handleRequest");
  }
  if (!Number.isInteger(maxConnections) || maxConnections <= 0) {
    throw new Error("createAgentCommandServer requires a positive maxConnections");
  }
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new Error("createAgentCommandServer requires a positive requestTimeoutMs");
  }
  if (typeof createServerFn !== "function") {
    throw new Error("createAgentCommandServer requires createServerFn to be a function");
  }
  if (typeof withSocketPathLockFn !== "function") {
    throw new Error("createAgentCommandServer requires withSocketPathLockFn to be a function");
  }

  let server = null;
  let serverReady = false;
  let startPromise = null;
  let stopPromise = null;
  let accepting = false;
  let ownedSocketIdentity = null;
  const sockets = new Set();
  const connections = new Set();
  const pendingRequests = new Set();
  const pendingWrites = new Set();
  let activeConnectionCount = 0;

  function queueEnvelope(socket, envelope) {
    const pending = writeEnvelope(socket, envelope)
      .catch((error) => {
        if (!socket.destroyed) {
          logger?.warn?.("agent command response failed", error);
        }
      })
      .finally(() => pendingWrites.delete(pending));
    pendingWrites.add(pending);
  }

  function stopAccepting() {
    accepting = false;
  }

  async function closeManagedServer(activeServer, activeSocketIdentity, { drain = true } = {}) {
    await withSocketPathLockFn(socketPath, async () => {
      const currentSocket = await getSocketPathEntry(socketPath);
      const pathWasRebound = Boolean(
        currentSocket &&
        activeSocketIdentity &&
        !hasFileIdentity(currentSocket, activeSocketIdentity),
      );
      const preserved = pathWasRebound
        ? await preserveReboundSocketPath(socketPath, activeSocketIdentity)
        : null;
      const closed = activeServer.listening
        ? new Promise((resolve, reject) => {
            activeServer.close((error) => (error ? reject(error) : resolve()));
          })
        : Promise.resolve();
      if (drain) {
        const connectedAuthoritativeRequests = Array.from(connections)
          .filter((connection) => (
            connection.handlerPending &&
            !connection.socketClosed &&
            connection.awaitAuthoritativeResult
          ))
          .map((connection) => connection.handlerSettledOrSocketClosed);
        if (connectedAuthoritativeRequests.length > 0) {
          await Promise.allSettled(connectedAuthoritativeRequests);
        }
      }
      if (drain && pendingRequests.size > 0) {
        let drainTimer;
        await Promise.race([
          Promise.allSettled(Array.from(pendingRequests)),
          new Promise((resolve) => {
            drainTimer = setTimeout(resolve, SHUTDOWN_REQUEST_DRAIN_MS);
          }),
        ]);
        clearTimeout(drainTimer);
      }
      if (drain && pendingWrites.size > 0) {
        let drainTimer;
        await Promise.race([
          Promise.allSettled(Array.from(pendingWrites)),
          new Promise((resolve) => {
            drainTimer = setTimeout(resolve, SHUTDOWN_RESPONSE_DRAIN_MS);
          }),
        ]);
        clearTimeout(drainTimer);
      }
      for (const socket of sockets) {
        socket.destroy();
      }
      for (const connection of connections) {
        connection.release(true);
      }
      await closed;
      await restoreReboundSocketPath(socketPath, preserved, logger);
    });
  }

  function clearManagedServer(activeServer) {
    if (server !== activeServer) {
      return;
    }
    server = null;
    serverReady = false;
    ownedSocketIdentity = null;
  }

  async function startServer() {
    if (server) {
      if (serverReady && accepting && server.listening) {
        return { socketPath };
      }
      const retainedServer = server;
      await closeManagedServer(retainedServer, ownedSocketIdentity, { drain: false });
      clearManagedServer(retainedServer);
    }

    await mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });
    let nextOwnedSocketIdentity = null;
    const nextServer = createServerFn((socket) => {
      if (activeConnectionCount >= maxConnections) {
        socket.destroy();
        return;
      }
      activeConnectionCount += 1;
      sockets.add(socket);
      let resolveHandlerSettledOrSocketClosed;
      const handlerSettledOrSocketClosed = new Promise((resolve) => {
        resolveHandlerSettledOrSocketClosed = resolve;
      });
      const connection = {
        awaitAuthoritativeResult: false,
        handlerPending: false,
        handlerSettledOrSocketClosed,
        released: false,
        socketClosed: false,
        signalHandlerSettledOrSocketClosed() {
          resolveHandlerSettledOrSocketClosed?.();
          resolveHandlerSettledOrSocketClosed = null;
        },
        release(force = false) {
          if (
            connection.released ||
            (!force && (!connection.socketClosed || connection.handlerPending))
          ) {
            return;
          }
          connection.released = true;
          activeConnectionCount -= 1;
          connections.delete(connection);
        },
      };
      connections.add(connection);
      socket.setEncoding("utf8");
      let buffer = "";
      let byteCount = 0;
      let handled = false;
      let responseQueued = false;
      let requestTimer = null;

      const clearRequestTimer = () => {
        clearTimeout(requestTimer);
        requestTimer = null;
      };

      const queueResponse = (envelope) => {
        if (responseQueued) {
          return false;
        }
        responseQueued = true;
        queueEnvelope(socket, envelope);
        return true;
      };

      const respondWithError = (error) => {
        if (handled) {
          return;
        }
        handled = true;
        clearRequestTimer();
        queueResponse({ ok: false, error: serializeError(error) });
      };

      const processRequest = () => {
        if (handled) {
          return;
        }
        const lineEnd = buffer.indexOf("\n");
        if (lineEnd === -1) {
          return;
        }

        const line = buffer.slice(0, lineEnd);
        const trailing = buffer.slice(lineEnd + 1).trim();
        if (trailing) {
          respondWithError(createProtocolError("Agent command accepts exactly one request per connection"));
          return;
        }

        let request;
        try {
          request = validateRequest(JSON.parse(line));
        } catch (error) {
          respondWithError(
            error?.code
              ? error
              : createProtocolError(`Invalid agent command JSON: ${error?.message ?? String(error)}`),
          );
          return;
        }

        if (!accepting) {
          const error = new Error("EasyConnect Workbench is shutting down");
          error.code = "EASYCONNECT_AGENT_SERVER_STOPPING";
          respondWithError(error);
          return;
        }

        handled = true;
        clearRequestTimer();
        connection.awaitAuthoritativeResult = AUTHORITATIVE_RESULT_COMMANDS.has(request.command);
        connection.handlerPending = true;
        const pending = Promise.resolve()
          .then(() => handleRequest(request))
          .then(
            (result) => {
              queueResponse({ ok: true, result });
            },
            (error) => {
              queueResponse({ ok: false, error: serializeError(error) });
            },
          )
          .finally(() => {
            pendingRequests.delete(pending);
            connection.handlerPending = false;
            connection.signalHandlerSettledOrSocketClosed();
            connection.release();
          });
        pendingRequests.add(pending);
      };

      requestTimer = setTimeout(() => {
        respondWithError(
          createProtocolError(
            `Agent command request was not completed within ${requestTimeoutMs}ms`,
            "EASYCONNECT_AGENT_REQUEST_TIMEOUT",
          ),
        );
      }, requestTimeoutMs);
      requestTimer.unref?.();

      socket.on("data", (chunk) => {
        if (handled) {
          if (`${chunk}`.trim()) {
            const queued = queueResponse({
              ok: false,
              error: serializeError(
                createProtocolError("Agent command accepts exactly one request per connection"),
              ),
            });
            if (!queued) {
              socket.destroy();
            }
          }
          return;
        }
        byteCount += Buffer.byteLength(chunk);
        if (byteCount > maxRequestBytes) {
          respondWithError(
            createProtocolError(
              `Agent command request exceeds ${maxRequestBytes} bytes`,
              "EASYCONNECT_AGENT_REQUEST_TOO_LARGE",
            ),
          );
          return;
        }
        buffer += chunk;
        processRequest();
      });
      socket.on("error", (error) => {
        clearRequestTimer();
        if (!handled) {
          logger?.warn?.("agent command socket failed", error);
        }
      });
      socket.on("close", () => {
        clearRequestTimer();
        sockets.delete(socket);
        connection.socketClosed = true;
        connection.signalHandlerSettledOrSocketClosed();
        connection.release();
      });
    });

    try {
      await withSocketPathLockFn(socketPath, async () => {
        await prepareSocketPath(socketPath);
        await new Promise((resolve, reject) => {
          const onError = (error) => {
            nextServer.off("listening", onListening);
            reject(error);
          };
          const onListening = () => {
            nextServer.on("error", (error) => {
              logger?.error?.("agent command server failed", error);
            });
            nextServer.off("error", onError);
            resolve();
          };
          nextServer.once("error", onError);
          nextServer.once("listening", onListening);
          nextServer.listen(socketPath);
        });

        nextOwnedSocketIdentity = getFileIdentity(await lstat(socketPath));
        await chmod(socketPath, 0o600);
      });
      ownedSocketIdentity = nextOwnedSocketIdentity;
      server = nextServer;
      serverReady = true;
      accepting = true;
      return { socketPath };
    } catch (error) {
      accepting = false;
      if (nextServer.listening) {
        server = nextServer;
        serverReady = false;
        ownedSocketIdentity = nextOwnedSocketIdentity;
        try {
          await closeManagedServer(nextServer, nextOwnedSocketIdentity, { drain: false });
          clearManagedServer(nextServer);
        } catch (cleanupError) {
          error.socketCleanupError = {
            code: cleanupError?.code,
            message: cleanupError?.message ?? String(cleanupError),
          };
        }
      }
      throw error;
    }
  }

  function start() {
    if (stopPromise) {
      return Promise.reject(
        createProtocolError(
          "EasyConnect Workbench command server is stopping",
          "EASYCONNECT_AGENT_SERVER_STOPPING",
        ),
      );
    }
    if (startPromise) {
      return startPromise;
    }
    startPromise = startServer().finally(() => {
      startPromise = null;
    });
    return startPromise;
  }

  function stop() {
    if (stopPromise) {
      return stopPromise;
    }

    stopPromise = (async () => {
      stopAccepting();
      if (startPromise) {
        await startPromise.catch(() => {});
        stopAccepting();
      }
      const activeServer = server;
      if (activeServer) {
        await closeManagedServer(activeServer, ownedSocketIdentity);
        clearManagedServer(activeServer);
      }
    })().finally(() => {
      stopPromise = null;
    });
    return stopPromise;
  }

  return {
    start,
    stop,
    stopAccepting,
    get socketPath() {
      return socketPath;
    },
  };
}

export function sendAgentCommand({
  socketPath,
  command,
  options = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
} = {}) {
  if (!socketPath) {
    return Promise.reject(new Error("sendAgentCommand requires socketPath"));
  }
  if (timeoutMs !== null && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    return Promise.reject(new Error("sendAgentCommand timeoutMs must be null or positive"));
  }

  let requestPayload;
  try {
    requestPayload = `${JSON.stringify({ command, options })}\n`;
  } catch {
    return Promise.reject(
      createProtocolError(
        "EasyConnect agent command request could not be serialized",
        "EASYCONNECT_AGENT_REQUEST_INVALID",
      ),
    );
  }

  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let response = "";
    let responseBytes = 0;
    let settled = false;
    let timeoutId = null;

    const finish = (handler, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      socket.destroy();
      handler(value);
    };

    const parseResponse = () => {
      const lineEnd = response.indexOf("\n");
      if (lineEnd === -1) {
        return false;
      }

      if (response.slice(lineEnd + 1).trim()) {
        finish(
          reject,
          createProtocolError("EasyConnect agent command returned trailing protocol data"),
        );
        return true;
      }

      let envelope;
      try {
        envelope = JSON.parse(response.slice(0, lineEnd));
      } catch (error) {
        const protocolError = createProtocolError(
          `Invalid agent command response: ${error?.message ?? String(error)}`,
        );
        finish(reject, protocolError);
        return true;
      }

      if (envelope?.ok === true) {
        const result = envelope.result;
        if (!result || typeof result !== "object" || Array.isArray(result)) {
          finish(
            reject,
            createProtocolError("EasyConnect agent command returned an invalid result"),
          );
          return true;
        }
        finish(resolve, result);
        return true;
      }

      const serializedError = envelope?.error;
      if (
        envelope?.ok !== false ||
        !serializedError ||
        typeof serializedError !== "object" ||
        Array.isArray(serializedError) ||
        typeof serializedError.message !== "string" ||
        !serializedError.message ||
        typeof serializedError.code !== "string" ||
        !serializedError.code
      ) {
        finish(
          reject,
          createProtocolError("EasyConnect agent command returned an invalid error envelope"),
        );
        return true;
      }

      const error = new Error(serializedError.message);
      for (const [key, value] of Object.entries(serializedError)) {
        if (key !== "message") {
          error[key] = value;
        }
      }
      finish(reject, error);
      return true;
    };

    socket.setEncoding("utf8");
    if (timeoutMs !== null) {
      timeoutId = setTimeout(() => {
        const error = new Error(`EasyConnect agent command timed out after ${timeoutMs}ms`);
        error.code = "EASYCONNECT_AGENT_TIMEOUT";
        finish(reject, error);
      }, timeoutMs);
      timeoutId.unref?.();
    }
    socket.once("error", (error) => finish(reject, markTransportError(error)));
    socket.on("data", (chunk) => {
      responseBytes += Buffer.byteLength(chunk);
      if (responseBytes > maxResponseBytes) {
        finish(
          reject,
          createProtocolError(
            `EasyConnect agent command response exceeds ${maxResponseBytes} bytes`,
          ),
        );
        return;
      }
      response += chunk;
    });
    socket.once("end", () => {
      if (!settled && !parseResponse()) {
        finish(reject, createProtocolError("EasyConnect agent command returned no response"));
      }
    });
    socket.once("connect", () => {
      socket.write(requestPayload);
    });
  });
}
