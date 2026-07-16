import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  link,
  lstat,
  mkdtemp as createFsTempDirectory,
  readFile,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";

import {
  createAgentCommandServer,
  sendAgentCommand,
} from "../src/services/agent-command-channel.js";

const temporaryDirectories = new Set();

async function mkdtemp(prefix) {
  const directory = await createFsTempDirectory(prefix);
  temporaryDirectories.add(directory);
  return directory;
}

test.after(async () => {
  await Promise.all(
    Array.from(temporaryDirectories, (directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function closeRawServer(server, sockets) {
  for (const socket of sockets) {
    socket.destroy();
  }
  if (!server.listening) {
    return;
  }
  await new Promise((resolve) => server.close(() => resolve()));
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

test("agent command channel exchanges one JSON request and protects the socket", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "easyconnect-agent-channel-"));
  const socketPath = path.join(directory, "agent.sock");
  const requests = [];
  const server = createAgentCommandServer({
    socketPath,
    async handleRequest(request) {
      requests.push(request);
      return { healthy: true, command: request.command };
    },
  });
  t.after(() => server.stop());

  await server.start();
  const socketStat = await stat(socketPath);
  assert.equal(socketStat.mode & 0o777, 0o600);

  const result = await sendAgentCommand({
    socketPath,
    command: "status",
    options: { fresh: true },
    timeoutMs: 1000,
  });

  assert.deepEqual(requests, [{ command: "status", options: { fresh: true } }]);
  assert.deepEqual(result, { healthy: true, command: "status" });

  await server.stop();
  await assert.rejects(stat(socketPath), (error) => error?.code === "ENOENT");
});

test("a second server cannot unlink or take over a live agent socket", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "easyconnect-agent-exclusive-"));
  const socketPath = path.join(directory, "agent.sock");
  const first = createAgentCommandServer({
    socketPath,
    async handleRequest() {
      return { owner: "first" };
    },
  });
  const second = createAgentCommandServer({
    socketPath,
    async handleRequest() {
      return { owner: "second" };
    },
  });
  t.after(() => Promise.allSettled([first.stop(), second.stop()]));

  await first.start();
  await assert.rejects(
    second.start(),
    (error) => error?.code === "EASYCONNECT_AGENT_SOCKET_IN_USE",
  );
  await second.stop();

  const result = await sendAgentCommand({ socketPath, command: "ping", timeoutMs: 1000 });
  assert.deepEqual(result, { owner: "first" });
});

test("concurrent server starts leave exactly one live socket owner", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "easyconnect-agent-concurrent-owner-"));
  const socketPath = path.join(directory, "agent.sock");
  const servers = ["first", "second"].map((owner) => createAgentCommandServer({
    socketPath,
    async handleRequest() {
      return { owner };
    },
  }));
  t.after(() => Promise.allSettled(servers.map((server) => server.stop())));

  const outcomes = await Promise.allSettled(servers.map((server) => server.start()));
  assert.deepEqual(
    outcomes.map((outcome) => outcome.status).sort(),
    ["fulfilled", "rejected"],
  );
  const rejected = outcomes.find((outcome) => outcome.status === "rejected");
  assert.equal(rejected.reason?.code, "EASYCONNECT_AGENT_SOCKET_IN_USE");

  const winner = outcomes.findIndex((outcome) => outcome.status === "fulfilled");
  assert.deepEqual(
    await sendAgentCommand({ socketPath, command: "ping", timeoutMs: 1000 }),
    { owner: winner === 0 ? "first" : "second" },
  );
});

test("socket path ownership changes are serialized across processes", async () => {
  const { withSocketPathLock } = await import("../src/services/agent-command-channel.js");
  assert.equal(typeof withSocketPathLock, "function");
  const directory = await mkdtemp(path.join(os.tmpdir(), "easyconnect-agent-lock-"));
  const socketPath = path.join(directory, "agent.sock");
  const firstAcquired = createDeferred();
  const releaseFirst = createDeferred();

  const first = withSocketPathLock(socketPath, async () => {
    firstAcquired.resolve();
    await releaseFirst.promise;
  });
  await firstAcquired.promise;

  try {
    await assert.rejects(
      withSocketPathLock(socketPath, async () => {}, { timeoutSeconds: 0 }),
      (error) => error?.code === "EASYCONNECT_AGENT_SOCKET_LOCK_TIMEOUT",
    );
  } finally {
    releaseFirst.resolve();
    await first;
  }
  await withSocketPathLock(socketPath, async () => {}, { timeoutSeconds: 0 });
});

test("agent command server startup retries the same server after a transient failure", async () => {
  const { createRetryableAgentCommandServerStarter } = await import(
    "../src/services/agent-command-channel.js"
  );
  assert.equal(typeof createRetryableAgentCommandServerStarter, "function");
  const firstAttemptStarted = createDeferred();
  const releaseFirstAttempt = createDeferred();
  let attempts = 0;
  const fakeServer = {
    async start() {
      attempts += 1;
      if (attempts === 1) {
        firstAttemptStarted.resolve();
        await releaseFirstAttempt.promise;
        const error = new Error("transient socket startup failure");
        error.code = "EADDRINUSE";
        throw error;
      }
      return { socketPath: "/tmp/agent.sock" };
    },
    stopAccepting() {},
    async stop() {},
  };
  let createCalls = 0;
  const starter = createRetryableAgentCommandServerStarter({
    createServer() {
      createCalls += 1;
      return fakeServer;
    },
  });

  const first = starter.start();
  const joinedFirst = starter.start();
  await firstAttemptStarted.promise;
  releaseFirstAttempt.resolve();
  await assert.rejects(first, (error) => error?.code === "EADDRINUSE");
  await assert.rejects(joinedFirst, (error) => error?.code === "EADDRINUSE");

  assert.equal(await starter.start(), fakeServer);
  assert.equal(await starter.start(), fakeServer);
  assert.equal(createCalls, 1);
  assert.equal(attempts, 2);
});

test("stale socket cleanup rechecks ownership before unlinking", async () => {
  const module = await import("../src/services/agent-command-channel.js");
  assert.equal(typeof module.prepareSocketPath, "function");
  const stale = { dev: 1, ino: 10, isSocket: () => true };
  const successor = { dev: 1, ino: 11, isSocket: () => true };
  const entries = [stale, successor, successor];
  let probeCount = 0;
  let removeCount = 0;

  await assert.rejects(
    module.prepareSocketPath("/tmp/agent.sock", {
      async getEntryFn() {
        return entries.shift() ?? successor;
      },
      async probeSocketFn() {
        probeCount += 1;
        return probeCount > 1;
      },
      async removeSocketFn() {
        removeCount += 1;
      },
    }),
    (error) => error?.code === "EASYCONNECT_AGENT_SOCKET_IN_USE",
  );
  assert.equal(removeCount, 0);
});

test("agent command server keeps a runtime error listener after listening", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "easyconnect-agent-runtime-error-"));
  const socketPath = path.join(directory, "agent.sock");
  const rawServer = new EventEmitter();
  rawServer.listening = false;
  rawServer.listen = (target) => {
    void writeFile(target, "socket-placeholder").then(() => {
      rawServer.listening = true;
      rawServer.emit("listening");
    });
  };
  rawServer.close = (callback) => {
    rawServer.listening = false;
    callback?.();
  };
  const logged = [];
  const server = createAgentCommandServer({
    socketPath,
    createServerFn() {
      return rawServer;
    },
    logger: {
      error(message, error) {
        logged.push([message, error?.code]);
      },
    },
    async handleRequest() {
      return { ready: true };
    },
  });
  t.after(() => server.stop());

  await server.start();
  const runtimeError = new Error("accept failed");
  runtimeError.code = "EMFILE";
  rawServer.emit("error", runtimeError);

  assert.deepEqual(logged, [["agent command server failed", "EMFILE"]]);
});

test("server shutdown waits for an in-progress start before closing", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "easyconnect-agent-start-stop-"));
  const socketPath = path.join(directory, "agent.sock");
  const server = createAgentCommandServer({
    socketPath,
    async handleRequest() {
      return { ready: true };
    },
  });

  const starting = server.start();
  const stopping = server.stop();
  await Promise.all([starting, stopping]);

  await assert.rejects(stat(socketPath), (error) => error?.code === "ENOENT");
  await assert.rejects(
    sendAgentCommand({ socketPath, command: "ping", timeoutMs: 100 }),
    (error) => ["ENOENT", "ECONNREFUSED"].includes(error?.code),
  );
});

test("a failed startup cleanup retains the listening server for a later stop", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "easyconnect-agent-start-cleanup-lock-"));
  const socketPath = path.join(directory, "agent.sock");
  let lockCalls = 0;
  const server = createAgentCommandServer({
    socketPath,
    async withSocketPathLockFn(_target, callback) {
      lockCalls += 1;
      if (lockCalls === 1) {
        await callback();
        const error = new Error("lock holder failed during release");
        error.code = "TEST_LOCK_RELEASE_FAILED";
        throw error;
      }
      if (lockCalls === 2) {
        const error = new Error("cleanup could not reacquire the lock");
        error.code = "TEST_LOCK_REACQUIRE_FAILED";
        throw error;
      }
      return callback();
    },
    async handleRequest() {
      return { ready: true };
    },
  });
  t.after(() => server.stop().catch(() => {}));

  await assert.rejects(
    server.start(),
    (error) => error?.code === "TEST_LOCK_RELEASE_FAILED",
  );
  assert.equal(lockCalls, 2);

  await server.stop();
  assert.equal(lockCalls, 3);
  await assert.rejects(lstat(socketPath), (error) => error?.code === "ENOENT");
});

test("a stop lock failure lets start replace the stopped command server", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "easyconnect-agent-stop-lock-retry-"));
  const socketPath = path.join(directory, "agent.sock");
  let lockCalls = 0;
  const server = createAgentCommandServer({
    socketPath,
    async withSocketPathLockFn(_target, callback) {
      lockCalls += 1;
      if (lockCalls === 2) {
        const error = new Error("stop could not acquire the lock");
        error.code = "TEST_STOP_LOCK_FAILED";
        throw error;
      }
      return callback();
    },
    async handleRequest() {
      return { ready: true };
    },
  });
  t.after(() => server.stop().catch(() => {}));

  await server.start();
  await assert.rejects(server.stop(), (error) => error?.code === "TEST_STOP_LOCK_FAILED");
  assert.equal(lockCalls, 2);

  await assert.rejects(
    sendAgentCommand({ socketPath, command: "status", timeoutMs: 200 }),
    (error) => error?.code === "EASYCONNECT_AGENT_SERVER_STOPPING",
  );

  await server.start();
  assert.equal(lockCalls, 4);
  assert.deepEqual(
    await sendAgentCommand({ socketPath, command: "status", timeoutMs: 200 }),
    { ready: true },
  );
  await server.stop();
  assert.equal(lockCalls, 5);
  await assert.rejects(lstat(socketPath), (error) => error?.code === "ENOENT");
});

test("a stop cleanup failure after close lets start bind a fresh server", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "easyconnect-agent-stop-cleanup-retry-"));
  const socketPath = path.join(directory, "agent.sock");
  let lockCalls = 0;
  const server = createAgentCommandServer({
    socketPath,
    async withSocketPathLockFn(_target, callback) {
      lockCalls += 1;
      const result = await callback();
      if (lockCalls === 2) {
        const error = new Error("stop lock release failed after close");
        error.code = "TEST_STOP_RELEASE_FAILED";
        throw error;
      }
      return result;
    },
    async handleRequest() {
      return { ready: true };
    },
  });
  t.after(() => server.stop().catch(() => {}));

  await server.start();
  await assert.rejects(server.stop(), (error) => error?.code === "TEST_STOP_RELEASE_FAILED");
  assert.equal(lockCalls, 2);

  await server.start();
  assert.equal(lockCalls, 4);
  assert.deepEqual(
    await sendAgentCommand({ socketPath, command: "status", timeoutMs: 200 }),
    { ready: true },
  );
  await server.stop();
  assert.equal(lockCalls, 5);
  await assert.rejects(lstat(socketPath), (error) => error?.code === "ENOENT");
});

test("agent command channel returns bounded structured handler errors", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "easyconnect-agent-error-"));
  const socketPath = path.join(directory, "agent.sock");
  const server = createAgentCommandServer({
    socketPath,
    async handleRequest() {
      const error = new Error("VPN is unhealthy");
      error.code = "EASYCONNECT_AGENT_VPN_UNHEALTHY";
      error.password = "must-not-cross-the-socket";
      error.dataPlane = { configured: true, ok: false, target: "tcp://intranet:443" };
      throw error;
    },
  });
  t.after(() => server.stop());
  await server.start();

  await assert.rejects(
    sendAgentCommand({ socketPath, command: "ensure", timeoutMs: 1000 }),
    (error) => {
      assert.equal(error.code, "EASYCONNECT_AGENT_VPN_UNHEALTHY");
      assert.equal(error.message, "VPN is unhealthy");
      assert.deepEqual(error.dataPlane, {
        configured: true,
        ok: false,
        target: "tcp://intranet:443",
      });
      assert.equal(error.password, undefined);
      return true;
    },
  );
});

test("an unserializable success becomes a bounded error and releases its slot", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "easyconnect-agent-unserializable-"));
  const socketPath = path.join(directory, "agent.sock");
  const server = createAgentCommandServer({
    socketPath,
    maxConnections: 1,
    async handleRequest(request) {
      if (request.command === "ensure") {
        return { command: request.command, unsupported: 1n };
      }
      return { command: request.command, ready: true };
    },
  });
  t.after(() => server.stop());
  await server.start();

  const outcome = await Promise.race([
    sendAgentCommand({ socketPath, command: "ensure", timeoutMs: null }).then(
      (value) => ({ value }),
      (error) => ({ error }),
    ),
    new Promise((resolve) => {
      setTimeout(() => resolve({ timedOut: true }), 150);
    }),
  ]);
  assert.equal(outcome.timedOut, undefined);
  assert.equal(outcome.error?.code, "EASYCONNECT_AGENT_RESPONSE_INVALID");

  assert.deepEqual(
    await sendAgentCommand({ socketPath, command: "ping", timeoutMs: 200 }),
    { command: "ping", ready: true },
  );
});

test("a circular error detail is omitted without hanging the client or connection slot", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "easyconnect-agent-circular-error-"));
  const socketPath = path.join(directory, "agent.sock");
  const server = createAgentCommandServer({
    socketPath,
    maxConnections: 1,
    async handleRequest(request) {
      if (request.command === "ensure") {
        const error = new Error("VPN state is circular");
        error.code = "EASYCONNECT_AGENT_VPN_UNHEALTHY";
        error.status = {};
        error.status.self = error.status;
        throw error;
      }
      return { command: request.command, ready: true };
    },
  });
  t.after(() => server.stop());
  await server.start();

  const outcome = await Promise.race([
    sendAgentCommand({ socketPath, command: "ensure", timeoutMs: null }).then(
      (value) => ({ value }),
      (error) => ({ error }),
    ),
    new Promise((resolve) => {
      setTimeout(() => resolve({ timedOut: true }), 150);
    }),
  ]);
  assert.equal(outcome.timedOut, undefined);
  assert.equal(outcome.error?.code, "EASYCONNECT_AGENT_VPN_UNHEALTHY");
  assert.equal(outcome.error?.status, undefined);

  assert.deepEqual(
    await sendAgentCommand({ socketPath, command: "ping", timeoutMs: 200 }),
    { command: "ping", ready: true },
  );
});

test("throwing error accessors preserve a bounded response and release the connection", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "easyconnect-agent-error-getter-"));
  const socketPath = path.join(directory, "agent.sock");
  const server = createAgentCommandServer({
    socketPath,
    maxConnections: 1,
    async handleRequest(request) {
      if (request.command === "ensure") {
        const error = new Error("VPN detail getter failed");
        error.code = "EASYCONNECT_AGENT_VPN_UNHEALTHY";
        Object.defineProperty(error, "status", {
          get() {
            throw new Error("status getter exploded");
          },
        });
        throw error;
      }
      if (request.command === "keepalive-start") {
        const error = {};
        for (const field of ["code", "message"]) {
          Object.defineProperty(error, field, {
            get() {
              throw new Error(`${field} getter exploded`);
            },
          });
        }
        throw error;
      }
      return { command: request.command, ready: true };
    },
  });
  t.after(() => server.stop());
  await server.start();

  await assert.rejects(
    sendAgentCommand({ socketPath, command: "ensure", timeoutMs: null }),
    (error) => {
      assert.equal(error?.code, "EASYCONNECT_AGENT_VPN_UNHEALTHY");
      assert.equal(error?.message, "VPN detail getter failed");
      assert.equal(error?.status, undefined);
      return true;
    },
  );
  await assert.rejects(
    sendAgentCommand({ socketPath, command: "keepalive-start", timeoutMs: null }),
    (error) => {
      assert.equal(error?.code, "EASYCONNECT_AGENT_COMMAND_FAILED");
      assert.equal(error?.message, "EasyConnect agent command failed");
      return true;
    },
  );
  assert.deepEqual(
    await sendAgentCommand({ socketPath, command: "ping", timeoutMs: 200 }),
    { command: "ping", ready: true },
  );
});

test("agent command channel normalizes numeric business error codes", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "easyconnect-agent-numeric-error-"));
  const socketPath = path.join(directory, "agent.sock");
  const server = createAgentCommandServer({
    socketPath,
    async handleRequest() {
      const error = new Error("upstream JSON-RPC failure");
      error.code = -32000;
      throw error;
    },
  });
  t.after(() => server.stop());
  await server.start();

  await assert.rejects(
    sendAgentCommand({ socketPath, command: "ensure", timeoutMs: 1000 }),
    (error) => {
      assert.equal(error.code, "-32000");
      assert.equal(error.message, "upstream JSON-RPC failure");
      assert.equal(error.agentTransport, undefined);
      return true;
    },
  );
});

test("agent command channel sanitizes diagnostic error messages and fields", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "easyconnect-agent-redaction-"));
  const socketPath = path.join(directory, "agent.sock");
  const server = createAgentCommandServer({
    socketPath,
    async handleRequest() {
      const error = new Error("recover failed password=secret-value sessionId=session-secret");
      error.code = "EASYCONNECT_AGENT_VPN_UNHEALTHY";
      error.status = { controlPlane: { sessionId: "session-secret" } };
      throw error;
    },
  });
  t.after(() => server.stop());
  await server.start();

  await assert.rejects(
    sendAgentCommand({ socketPath, command: "ensure", timeoutMs: 1000 }),
    (error) => {
      const output = JSON.stringify({ message: error.message, status: error.status });
      assert.equal(output.includes("secret-value"), false);
      assert.equal(output.includes("session-secret"), false);
      assert.match(error.message, /password=<redacted>/);
      assert.equal(error.status.controlPlane.sessionId, "<redacted>");
      return true;
    },
  );
});

test("agent command client keeps its write side open until an asynchronous response arrives", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "easyconnect-agent-delayed-"));
  const socketPath = path.join(directory, "agent.sock");
  const server = createAgentCommandServer({
    socketPath,
    async handleRequest(request) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { command: request.command, ready: true };
    },
  });
  t.after(() => server.stop());
  await server.start();

  const result = await sendAgentCommand({
    socketPath,
    command: "ping",
    timeoutMs: 1000,
  });

  assert.deepEqual(result, { command: "ping", ready: true });
});

test("server shutdown lets an accepted command return before closing sockets", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "easyconnect-agent-drain-"));
  const socketPath = path.join(directory, "agent.sock");
  let releaseRequest;
  let markRequestStarted;
  const requestStarted = new Promise((resolve) => {
    markRequestStarted = resolve;
  });
  const requestReleased = new Promise((resolve) => {
    releaseRequest = resolve;
  });
  const server = createAgentCommandServer({
    socketPath,
    async handleRequest() {
      markRequestStarted();
      await requestReleased;
      return { completed: true };
    },
  });
  t.after(() => server.stop());
  await server.start();

  let clientSettled = false;
  const clientResult = sendAgentCommand({
    socketPath,
    command: "ensure",
    timeoutMs: 1000,
  }).finally(() => {
    clientSettled = true;
  });
  await requestStarted;
  const stopping = server.stop();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(clientSettled, false);
  releaseRequest();
  assert.deepEqual(await clientResult, { completed: true });
  await stopping;
});

test("server shutdown waits beyond the drain budget for a connected mutation result", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "easyconnect-agent-long-mutation-"));
  const socketPath = path.join(directory, "agent.sock");
  const requestStarted = createDeferred();
  const releaseRequest = createDeferred();
  let handlerFinished = false;
  const server = createAgentCommandServer({
    socketPath,
    async handleRequest(request) {
      requestStarted.resolve();
      await releaseRequest.promise;
      handlerFinished = true;
      return { command: request.command, completed: true };
    },
  });
  await server.start();

  let clientSettled = false;
  const clientResult = sendAgentCommand({
    socketPath,
    command: "ensure",
    timeoutMs: null,
  }).then(
    (value) => ({ value }),
    (error) => ({ error }),
  ).finally(() => {
    clientSettled = true;
  });
  await requestStarted.promise;
  let stopSettled = false;
  const stopping = server.stop().finally(() => {
    stopSettled = true;
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal(handlerFinished, false);
    assert.equal(clientSettled, false);
    assert.equal(stopSettled, false);

    releaseRequest.resolve();
    assert.deepEqual(await clientResult, {
      value: { command: "ensure", completed: true },
    });
    await stopping;
  } finally {
    releaseRequest.resolve();
    await Promise.allSettled([clientResult, stopping]);
  }
});

test("server shutdown destroys a client that keeps its write side half-open", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "easyconnect-agent-half-open-"));
  const socketPath = path.join(directory, "agent.sock");
  const server = createAgentCommandServer({
    socketPath,
    async handleRequest() {
      return { completed: true };
    },
  });
  await server.start();

  const client = net.createConnection({ path: socketPath, allowHalfOpen: true });
  let response = "";
  const responseReceived = new Promise((resolve, reject) => {
    client.setEncoding("utf8");
    client.once("error", reject);
    client.on("data", (chunk) => {
      response += chunk;
      if (response.includes("\n")) {
        resolve();
      }
    });
    client.once("connect", () => {
      client.write(`${JSON.stringify({ command: "status", options: {} })}\n`);
    });
  });
  await responseReceived;

  let timeoutId;
  try {
    await Promise.race([
      server.stop(),
      new Promise((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error("server stop timed out on half-open client")),
          250,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
  client.destroy();
  assert.equal(JSON.parse(response.trim()).ok, true);
});

test("server releases a connection slot after replying to a half-open client", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "easyconnect-agent-half-open-slot-"));
  const socketPath = path.join(directory, "agent.sock");
  const server = createAgentCommandServer({
    socketPath,
    maxConnections: 1,
    async handleRequest(request) {
      return { command: request.command, ready: true };
    },
  });
  await server.start();

  const first = net.createConnection({ path: socketPath, allowHalfOpen: true });
  let response = "";
  const responseReceived = new Promise((resolve, reject) => {
    first.setEncoding("utf8");
    first.once("error", reject);
    first.on("data", (chunk) => {
      response += chunk;
      if (response.includes("\n")) {
        resolve();
      }
    });
    first.once("connect", () => {
      first.write(`${JSON.stringify({ command: "status", options: {} })}\n`);
    });
  });

  try {
    await responseReceived;
    await new Promise((resolve) => setImmediate(resolve));
    const second = await sendAgentCommand({ socketPath, command: "ping", timeoutMs: 1000 });
    assert.deepEqual(second, { command: "ping", ready: true });
  } finally {
    first.destroy();
    await server.stop();
  }
});

test("server shutdown bounds response drain when a client does not read", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "easyconnect-agent-backpressure-"));
  const socketPath = path.join(directory, "agent.sock");
  let markRequestStarted;
  const requestStarted = new Promise((resolve) => {
    markRequestStarted = resolve;
  });
  const server = createAgentCommandServer({
    socketPath,
    async handleRequest() {
      markRequestStarted();
      return { command: "config", payload: "x".repeat(16 * 1024 * 1024) };
    },
  });
  await server.start();

  const client = net.createConnection(socketPath);
  client.pause();
  client.once("connect", () => {
    client.write(`${JSON.stringify({ command: "config", options: {} })}\n`);
  });
  await requestStarted;
  await new Promise((resolve) => setImmediate(resolve));

  let timeoutId;
  try {
    await Promise.race([
      server.stop(),
      new Promise((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error("server stop timed out while the client was not reading")),
          1500,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeoutId);
    client.destroy();
    await server.stop();
  }
});

test("server closes a client that does not complete its request before the deadline", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "easyconnect-agent-request-deadline-"));
  const socketPath = path.join(directory, "agent.sock");
  const server = createAgentCommandServer({
    socketPath,
    requestTimeoutMs: 30,
    async handleRequest() {
      throw new Error("incomplete requests must not reach the handler");
    },
  });
  await server.start();

  const client = net.createConnection(socketPath);
  let response = "";
  const ended = new Promise((resolve, reject) => {
    client.setEncoding("utf8");
    client.on("data", (chunk) => {
      response += chunk;
    });
    client.once("error", reject);
    client.once("end", resolve);
    client.once("connect", () => client.write("{"));
  });

  let timeoutId;
  try {
    await Promise.race([
      ended,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error("incomplete request stayed open")), 300);
      }),
    ]);
    const envelope = JSON.parse(response.trim());
    assert.equal(envelope.ok, false);
    assert.equal(envelope.error.code, "EASYCONNECT_AGENT_REQUEST_TIMEOUT");
  } finally {
    clearTimeout(timeoutId);
    client.destroy();
    await server.stop();
  }
});

test("server rejects connections beyond its configured concurrent limit", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "easyconnect-agent-connection-limit-"));
  const socketPath = path.join(directory, "agent.sock");
  const server = createAgentCommandServer({
    socketPath,
    maxConnections: 1,
    async handleRequest() {
      return { ready: true };
    },
  });
  await server.start();

  const first = net.createConnection(socketPath);
  await new Promise((resolve, reject) => {
    first.once("connect", resolve);
    first.once("error", reject);
  });
  const second = net.createConnection(socketPath);
  second.on("error", () => {});
  const secondClosed = new Promise((resolve) => second.once("close", resolve));

  let timeoutId;
  try {
    await Promise.race([
      secondClosed,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error("excess connection stayed open")), 300);
      }),
    ]);
  } finally {
    clearTimeout(timeoutId);
    first.destroy();
    second.destroy();
    await server.stop();
  }
});

test("a disconnected in-flight handler keeps its connection slot until it settles", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "easyconnect-agent-inflight-limit-"));
  const socketPath = path.join(directory, "agent.sock");
  const firstStarted = createDeferred();
  const releaseFirst = createDeferred();
  const firstFinished = createDeferred();
  let handlerCalls = 0;
  const server = createAgentCommandServer({
    socketPath,
    maxConnections: 1,
    async handleRequest(request) {
      handlerCalls += 1;
      if (handlerCalls === 1) {
        firstStarted.resolve();
        await releaseFirst.promise;
        firstFinished.resolve();
      }
      return { command: request.command, ready: true };
    },
  });
  await server.start();

  const first = net.createConnection(socketPath);
  first.on("error", () => {});
  first.once("connect", () => {
    first.write(`${JSON.stringify({ command: "status", options: {} })}\n`);
  });
  await firstStarted.promise;
  const firstClosed = new Promise((resolve) => first.once("close", resolve));
  first.destroy();
  await firstClosed;
  await new Promise((resolve) => setTimeout(resolve, 25));

  const second = net.createConnection(socketPath);
  second.on("error", () => {});
  const secondClosed = new Promise((resolve) => second.once("close", resolve));
  second.once("connect", () => {
    second.write(`${JSON.stringify({ command: "ping", options: {} })}\n`);
  });

  try {
    await Promise.race([
      secondClosed,
      new Promise((resolve) => setTimeout(resolve, 75)),
    ]);
    assert.equal(handlerCalls, 1);

    releaseFirst.resolve();
    await firstFinished.promise;
    await new Promise((resolve) => setImmediate(resolve));
    const third = await sendAgentCommand({ socketPath, command: "ping", timeoutMs: 1000 });
    assert.deepEqual(third, { command: "ping", ready: true });
    assert.equal(handlerCalls, 2);
  } finally {
    releaseFirst.resolve();
    second.destroy();
    await server.stop();
  }
});

test("a disconnected handler cannot release its slot before the underlying work settles", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "easyconnect-agent-handler-timeout-"));
  const socketPath = path.join(directory, "agent.sock");
  const requestStarted = createDeferred();
  const releaseRequest = createDeferred();
  let handlerCalls = 0;
  const server = createAgentCommandServer({
    socketPath,
    maxConnections: 1,
    async handleRequest(request) {
      handlerCalls += 1;
      if (request.command === "hold") {
        requestStarted.resolve();
        await releaseRequest.promise;
      }
      return { command: request.command, ready: true };
    },
  });
  t.after(async () => {
    releaseRequest.resolve();
    await server.stop();
  });
  await server.start();

  const first = net.createConnection(socketPath);
  first.on("error", () => {});
  first.once("connect", () => {
    first.write(`${JSON.stringify({ command: "hold", options: {} })}\n`);
  });
  await requestStarted.promise;
  first.destroy();

  await new Promise((resolve) => setTimeout(resolve, 60));
  const second = net.createConnection(socketPath);
  second.on("error", () => {});
  second.once("connect", () => {
    second.write(`${JSON.stringify({ command: "ping", options: {} })}\n`);
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(handlerCalls, 1);

  releaseRequest.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  const result = await sendAgentCommand({ socketPath, command: "ping", timeoutMs: 200 });
  assert.deepEqual(result, { command: "ping", ready: true });
  assert.equal(handlerCalls, 2);
  second.destroy();
});

test("mutating commands can wait for their real result without a false client timeout", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "easyconnect-agent-mutating-wait-"));
  const socketPath = path.join(directory, "agent.sock");
  const requestStarted = createDeferred();
  const releaseRequest = createDeferred();
  const server = createAgentCommandServer({
    socketPath,
    async handleRequest(request) {
      requestStarted.resolve();
      await releaseRequest.promise;
      return { command: request.command, healthy: true };
    },
  });
  t.after(() => server.stop());
  await server.start();

  let requestSettled = false;
  const request = sendAgentCommand({
    socketPath,
    command: "ensure",
    timeoutMs: null,
  }).then(
    (value) => ({ value }),
    (error) => ({ error }),
  ).finally(() => {
    requestSettled = true;
  });
  await requestStarted.promise;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(requestSettled, false);
  releaseRequest.resolve();

  assert.deepEqual(await request, {
    value: { command: "ensure", healthy: true },
  });
});

test("server shutdown bounds a disconnected in-flight handler", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "easyconnect-agent-inflight-stop-"));
  const socketPath = path.join(directory, "agent.sock");
  const requestStarted = createDeferred();
  const releaseRequest = createDeferred();
  const server = createAgentCommandServer({
    socketPath,
    async handleRequest() {
      requestStarted.resolve();
      await releaseRequest.promise;
      return { completed: true };
    },
  });
  await server.start();

  const client = net.createConnection(socketPath);
  client.on("error", () => {});
  client.once("connect", () => {
    client.write(`${JSON.stringify({ command: "ensure", options: {} })}\n`);
  });
  await requestStarted.promise;
  const clientClosed = new Promise((resolve) => client.once("close", resolve));
  client.destroy();
  await clientClosed;

  const stopping = server.stop();
  let timeoutId;
  try {
    await Promise.race([
      stopping,
      new Promise((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error("server stop waited indefinitely for a disconnected handler")),
          800,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeoutId);
    releaseRequest.resolve();
    await stopping;
  }
});

test("the same server can restart while an old disconnected handler is still unresolved", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "easyconnect-agent-restart-inflight-"));
  const socketPath = path.join(directory, "agent.sock");
  const oldRequestStarted = createDeferred();
  const releaseOldRequest = createDeferred();
  const server = createAgentCommandServer({
    socketPath,
    maxConnections: 1,
    async handleRequest(request) {
      if (request.command === "hold") {
        oldRequestStarted.resolve();
        await releaseOldRequest.promise;
      }
      return { command: request.command, ready: true };
    },
  });
  await server.start();

  const oldClient = net.createConnection(socketPath);
  oldClient.on("error", () => {});
  oldClient.once("connect", () => {
    oldClient.write(`${JSON.stringify({ command: "hold", options: {} })}\n`);
  });
  await oldRequestStarted.promise;
  const oldClientClosed = new Promise((resolve) => oldClient.once("close", resolve));
  oldClient.destroy();
  await oldClientClosed;

  try {
    await server.stop();
    await server.start();
    const result = await sendAgentCommand({ socketPath, command: "ping", timeoutMs: 1000 });
    assert.deepEqual(result, { command: "ping", ready: true });
  } finally {
    releaseOldRequest.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    await server.stop();
  }
});

test("an old server shutdown preserves a successor that rebound the socket path", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "easyconnect-agent-successor-"));
  const socketPath = path.join(directory, "agent.sock");
  const first = createAgentCommandServer({
    socketPath,
    async handleRequest() {
      return { owner: "first" };
    },
  });
  const second = createAgentCommandServer({
    socketPath,
    async handleRequest() {
      return { owner: "second" };
    },
  });
  t.after(() => Promise.allSettled([first.stop(), second.stop()]));

  await first.start();
  await unlink(socketPath);
  await second.start();
  await first.stop();

  const result = await sendAgentCommand({ socketPath, command: "ping", timeoutMs: 1000 });
  assert.deepEqual(result, { owner: "second" });
});

test("socket restoration never overwrites a newer successor that binds during restore", async () => {
  const module = await import("../src/services/agent-command-channel.js");
  assert.equal(typeof module.restoreReboundSocketPath, "function");

  const directory = await mkdtemp(path.join(os.tmpdir(), "easyconnect-agent-restore-race-"));
  const socketPath = path.join(directory, "agent.sock");
  const preservedPath = path.join(directory, "agent.sock.preserved");
  await writeFile(preservedPath, "older-successor");
  const preservedStat = await lstat(preservedPath);
  const warnings = [];

  await module.restoreReboundSocketPath(
    socketPath,
    {
      path: preservedPath,
      identity: { dev: preservedStat.dev, ino: preservedStat.ino },
    },
    { warn: (message) => warnings.push(message) },
    {
      async linkFn(source, target) {
        await writeFile(target, "newer-successor");
        return link(source, target);
      },
    },
  );

  assert.equal(await readFile(socketPath, "utf8"), "newer-successor");
  await assert.rejects(readFile(preservedPath, "utf8"), (error) => error?.code === "ENOENT");
  assert.equal(warnings.length, 1);
});

test("socket restoration retries when the conflicting newer path disappears", async () => {
  const module = await import("../src/services/agent-command-channel.js");
  const directory = await mkdtemp(path.join(os.tmpdir(), "easyconnect-agent-restore-disappeared-"));
  const socketPath = path.join(directory, "agent.sock");
  const preservedPath = path.join(directory, "agent.sock.preserved");
  await writeFile(preservedPath, "preserved-successor");
  const preservedStat = await lstat(preservedPath);
  let linkAttempts = 0;

  await module.restoreReboundSocketPath(
    socketPath,
    {
      path: preservedPath,
      identity: { dev: preservedStat.dev, ino: preservedStat.ino },
    },
    console,
    {
      async linkFn(source, target) {
        linkAttempts += 1;
        if (linkAttempts === 1) {
          await writeFile(target, "disappearing-newer-successor");
          await unlink(target);
          const error = new Error("link EEXIST");
          error.code = "EEXIST";
          throw error;
        }
        return link(source, target);
      },
    },
  );

  assert.equal(linkAttempts, 2);
  assert.equal(await readFile(socketPath, "utf8"), "preserved-successor");
  await assert.rejects(readFile(preservedPath, "utf8"), (error) => error?.code === "ENOENT");
});

test("agent command channel rejects a second document sent after handling starts", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "easyconnect-agent-late-trailing-"));
  const socketPath = path.join(directory, "agent.sock");
  const handlerStarted = createDeferred();
  const releaseHandler = createDeferred();
  const server = createAgentCommandServer({
    socketPath,
    async handleRequest() {
      handlerStarted.resolve();
      await releaseHandler.promise;
      return { command: "status", healthy: true };
    },
  });
  t.after(async () => {
    releaseHandler.resolve();
    await server.stop();
  });
  await server.start();

  const socket = net.createConnection(socketPath);
  let response = "";
  const responseEnded = new Promise((resolve, reject) => {
    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.on("data", (chunk) => {
      response += chunk;
    });
    socket.once("end", resolve);
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ command: "status", options: {} })}\n`);
    });
  });

  await handlerStarted.promise;
  socket.write(`${JSON.stringify({ command: "ensure", options: {} })}\n`);
  let responseTimer;
  try {
    await Promise.race([
      responseEnded,
      new Promise((_, reject) => {
        responseTimer = setTimeout(
          () => reject(new Error("server accepted a second document while the first handler was pending")),
          100,
        );
      }),
    ]);
  } finally {
    clearTimeout(responseTimer);
    releaseHandler.resolve();
  }

  const envelope = JSON.parse(response.trim());
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, "EASYCONNECT_AGENT_PROTOCOL_INVALID");
});

test("agent command channel rejects malformed and oversized requests", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "easyconnect-agent-invalid-"));
  const socketPath = path.join(directory, "agent.sock");
  const server = createAgentCommandServer({
    socketPath,
    maxRequestBytes: 128,
    async handleRequest() {
      throw new Error("handler must not run");
    },
  });
  t.after(() => server.stop());
  await server.start();

  const sendRaw = (payload) => new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let response = "";
    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.on("data", (chunk) => {
      response += chunk;
    });
    socket.once("end", () => resolve(JSON.parse(response.trim())));
    socket.once("connect", () => socket.end(payload));
  });

  const malformed = await sendRaw("not-json\n");
  assert.equal(malformed.ok, false);
  assert.equal(malformed.error.code, "EASYCONNECT_AGENT_PROTOCOL_INVALID");

  const oversized = await sendRaw(`${JSON.stringify({ command: "x".repeat(256) })}\n`);
  assert.equal(oversized.ok, false);
  assert.equal(oversized.error.code, "EASYCONNECT_AGENT_REQUEST_TOO_LARGE");
});

test("agent command client rejects non-serializable request options", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ec-agent-request-"));
  const socketPath = path.join(directory, "agent.sock");
  const server = createAgentCommandServer({
    socketPath,
    async handleRequest(request) {
      return { command: request.command, ready: true };
    },
  });
  t.after(() => server.stop());
  await server.start();

  const circular = {};
  circular.self = circular;
  for (const options of [circular, { unsupported: 1n }]) {
    await assert.rejects(
      sendAgentCommand({ socketPath, command: "status", options, timeoutMs: 200 }),
      (error) => error?.code === "EASYCONNECT_AGENT_REQUEST_INVALID",
    );
  }
});

test("agent command client rejects a malformed failure envelope", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "easyconnect-agent-envelope-"));
  const socketPath = path.join(directory, "agent.sock");
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.once("data", () => socket.end("{}\n"));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });

  try {
    await assert.rejects(
      sendAgentCommand({ socketPath, command: "status", timeoutMs: 1000 }),
      (error) => error?.code === "EASYCONNECT_AGENT_PROTOCOL_INVALID",
    );
  } finally {
    await closeRawServer(server, sockets);
  }
});

test("agent command client rejects trailing protocol documents", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "easyconnect-agent-trailing-response-"));
  const socketPath = path.join(directory, "agent.sock");
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.once("data", () => {
      socket.end(
        `${JSON.stringify({ ok: true, result: { command: "status", healthy: true } })}\n` +
        `${JSON.stringify({ ok: true, result: { command: "status", healthy: false } })}\n`,
      );
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });

  try {
    await assert.rejects(
      sendAgentCommand({ socketPath, command: "status", timeoutMs: 1000 }),
      (error) => error?.code === "EASYCONNECT_AGENT_PROTOCOL_INVALID",
    );
  } finally {
    await closeRawServer(server, sockets);
  }
});

test("agent command client marks local socket failures as transport errors", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "easyconnect-agent-transport-"));
  const socketPath = path.join(directory, "missing.sock");

  await assert.rejects(
    sendAgentCommand({ socketPath, command: "status", timeoutMs: 100 }),
    (error) => {
      assert.equal(error?.code, "ENOENT");
      assert.equal(error?.agentTransport, true);
      return true;
    },
  );
});

test("agent command client enforces a total deadline during partial responses", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "easyconnect-agent-deadline-"));
  const socketPath = path.join(directory, "agent.sock");
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("data", () => {
      let writes = 0;
      const interval = setInterval(() => {
        writes += 1;
        socket.write("x");
        if (writes >= 12) {
          clearInterval(interval);
          socket.end();
        }
      }, 10);
      socket.once("close", () => clearInterval(interval));
      socket.once("error", () => clearInterval(interval));
    });
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });

  try {
    await assert.rejects(
      sendAgentCommand({ socketPath, command: "status", timeoutMs: 30 }),
      (error) => error?.code === "EASYCONNECT_AGENT_TIMEOUT",
    );
  } finally {
    await closeRawServer(server, sockets);
  }
});

test("agent command client rejects an oversized response before buffering it indefinitely", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "easyconnect-agent-response-limit-"));
  const socketPath = path.join(directory, "agent.sock");
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.once("data", () => socket.end("x".repeat(2 * 1024 * 1024)));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });

  try {
    await assert.rejects(
      sendAgentCommand({ socketPath, command: "status", timeoutMs: 1000 }),
      (error) => {
        assert.equal(error?.code, "EASYCONNECT_AGENT_PROTOCOL_INVALID");
        assert.match(error.message, /exceeds/);
        return true;
      },
    );
  } finally {
    await closeRawServer(server, sockets);
  }
});
