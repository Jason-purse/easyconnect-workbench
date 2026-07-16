import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import {
  EXIT_CODES,
  launchInstalledWorkbench,
  parseCliArgs,
  runCli,
} from "../src/cli/easyconnect-vpn.js";

function createOutput() {
  let stdout = "";
  let stderr = "";
  return {
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
    getStdout: () => stdout,
    getStderr: () => stderr,
  };
}

function createConfigResult(overrides = {}) {
  return {
    command: "config",
    credentials: {
      usernameConfigured: true,
      passwordConfigured: true,
    },
    dataPlaneProbeTarget: "tcp://192.0.2.10:443",
    dataPlaneProbeTimeoutMs: 5000,
    maintainerAutoStart: true,
    maintainerIntervalSeconds: 300,
    quietHours: {
      enabled: true,
      start: "18:30",
      end: "09:00",
    },
    lastKnownGateway: { host: "vpn.example.test", port: 9898 },
    gateways: [{ host: "vpn.example.test", port: 9898 }],
    ...overrides,
  };
}

function createHealthyResult(command, overrides = {}) {
  return {
    command,
    healthy: true,
    reason: "vpn-ready",
    controlPlane: {
      online: true,
      sessionId: "sess…on-1",
      loginStatus: "1",
      serviceState: { base: "18", l3vpn: "18", tcp: "43" },
    },
    dataPlane: {
      configured: true,
      ok: true,
      state: "reachable",
      route: { interface: "utun5", gateway: "2.0.1.18", tunneled: true },
    },
    ...overrides,
  };
}

test("parseCliArgs maps agent-friendly command forms to protocol commands", () => {
  assert.deepEqual(parseCliArgs(["--json", "status"]), {
    json: true,
    launch: true,
    timeoutMs: 300000,
    startupTimeoutMs: 15000,
    command: "status",
    options: {},
  });
  assert.deepEqual(parseCliArgs(["ensure", "--ignore-quiet-hours"]), {
    json: false,
    launch: true,
    timeoutMs: null,
    startupTimeoutMs: 15000,
    command: "ensure",
    options: { ignoreQuietHours: true },
  });
  assert.equal(parseCliArgs(["--json", "keepalive", "start"]).command, "keepalive-start");
  assert.equal(parseCliArgs(["--json", "keepalive", "start"]).timeoutMs, null);
  assert.equal(parseCliArgs(["keepalive", "stop"]).command, "keepalive-stop");
  assert.equal(parseCliArgs(["keepalive", "stop"]).timeoutMs, null);
  assert.equal(parseCliArgs(["status", "--timeout-seconds", "0.0001"]).timeoutMs, 1);
  assert.throws(
    () => parseCliArgs(["ensure", "--timeout-seconds", "120"]),
    (error) => error?.code === "EASYCONNECT_CLI_USAGE",
  );
  assert.throws(
    () => parseCliArgs(["status", "--timeout-seconds", "1e308"]),
    (error) => error?.code === "EASYCONNECT_CLI_USAGE",
  );
});

test("runCli emits valid JSON and returns unhealthy status as exit 3", async () => {
  const output = createOutput();
  const code = await runCli(["--json", "status"], {
    ...output,
    async sendCommand() {
      return {
        command: "status",
        healthy: false,
        reason: "data-plane-unreachable",
        controlPlane: { online: true },
        dataPlane: {
          configured: true,
          ok: false,
          route: { interface: "utun5", tunneled: true },
        },
      };
    },
  });

  assert.equal(code, EXIT_CODES.unhealthy);
  assert.equal(JSON.parse(output.getStdout()).reason, "data-plane-unreachable");
  assert.equal(output.getStderr(), "");
});

test("runCli returns exit 3 when quiet hours suppress keepalive start", async () => {
  const output = createOutput();
  const code = await runCli(["--json", "keepalive", "start"], {
    ...output,
    async sendCommand() {
      return {
        command: "keepalive-start",
        running: false,
        quietHours: { active: true, start: "18:30", end: "09:00" },
      };
    },
  });

  assert.equal(code, EXIT_CODES.unhealthy);
  const payload = JSON.parse(output.getStdout());
  assert.equal(payload.ok, true);
  assert.equal(payload.running, false);
});

test("runCli returns exit 3 when keepalive stop leaves maintenance running", async () => {
  const output = createOutput();
  const code = await runCli(["--json", "keepalive", "stop"], {
    ...output,
    async sendCommand() {
      return {
        command: "keepalive-stop",
        running: true,
      };
    },
  });

  assert.equal(code, EXIT_CODES.unhealthy);
  const payload = JSON.parse(output.getStdout());
  assert.equal(payload.ok, true);
  assert.equal(payload.running, true);
});

test("runCli returns exit 3 for incomplete keepalive configuration", async () => {
  const output = createOutput();
  const code = await runCli(["--json", "keepalive", "start"], {
    ...output,
    async sendCommand() {
      const error = new Error("Configure EasyConnect credentials in Workbench before starting keepalive");
      error.code = "EASYCONNECT_AGENT_CONFIG_INCOMPLETE";
      error.reason = "credentials-unconfigured";
      throw error;
    },
  });

  assert.equal(code, EXIT_CODES.unhealthy);
  const payload = JSON.parse(output.getStdout());
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, "EASYCONNECT_AGENT_CONFIG_INCOMPLETE");
  assert.equal(payload.error.reason, "credentials-unconfigured");
});

test("runCli emits one valid error document for a malformed successful result", async () => {
  const output = createOutput();
  const code = await runCli(["--json", "--no-launch", "status"], {
    ...output,
    async sendCommand() {
      return undefined;
    },
  });

  assert.equal(code, EXIT_CODES.unavailable);
  const payload = JSON.parse(output.getStdout());
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, "EASYCONNECT_AGENT_PROTOCOL_INVALID");
  assert.equal(output.getStdout().trim().split("\n").length, 1);
});

test("runCli rejects healthy status without control-plane and tunneled data-plane evidence", async () => {
  const output = createOutput();
  const code = await runCli(["--json", "--no-launch", "status"], {
    ...output,
    async sendCommand() {
      return { command: "status", healthy: true };
    },
  });

  assert.equal(code, EXIT_CODES.unavailable);
  assert.equal(JSON.parse(output.getStdout()).error.code, "EASYCONNECT_AGENT_PROTOCOL_INVALID");
});

test("runCli launches hidden Workbench once when the socket is unavailable", async () => {
  const output = createOutput();
  const calls = [];
  let attempt = 0;
  const code = await runCli(["--json", "ensure"], {
    ...output,
    async sendCommand(request) {
      calls.push(["send", request.command]);
      attempt += 1;
      if (attempt === 1) {
        const error = new Error("connect ENOENT");
        error.code = "ENOENT";
        error.agentTransport = true;
        throw error;
      }
      return createHealthyResult("ensure", { action: "already-healthy" });
    },
    async launchWorkbench() {
      calls.push(["launch"]);
    },
    async waitForReady() {
      calls.push(["wait"]);
    },
  });

  assert.equal(code, EXIT_CODES.ok);
  assert.deepEqual(calls, [
    ["send", "ensure"],
    ["launch"],
    ["wait"],
    ["send", "ensure"],
  ]);
});

test("runCli relaunches hidden Workbench when the command server is stopping", async () => {
  const output = createOutput();
  const calls = [];
  let attempt = 0;
  const code = await runCli(["--json", "status"], {
    ...output,
    async sendCommand(request) {
      calls.push(["send", request.command]);
      attempt += 1;
      if (attempt === 1) {
        const error = new Error("EasyConnect Workbench is shutting down");
        error.code = "EASYCONNECT_AGENT_SERVER_STOPPING";
        throw error;
      }
      return createHealthyResult("status");
    },
    async launchWorkbench() {
      calls.push(["launch"]);
    },
    async waitForReady() {
      calls.push(["wait"]);
    },
  });

  assert.equal(code, EXIT_CODES.ok);
  assert.deepEqual(calls, [
    ["send", "status"],
    ["launch"],
    ["wait"],
    ["send", "status"],
  ]);
});

test("runCli classifies a stopping command server as unavailable when launch is disabled", async () => {
  const output = createOutput();
  const code = await runCli(["--json", "--no-launch", "status"], {
    ...output,
    async sendCommand() {
      const error = new Error("EasyConnect Workbench is shutting down");
      error.code = "EASYCONNECT_AGENT_SERVER_STOPPING";
      throw error;
    },
  });

  assert.equal(code, EXIT_CODES.unavailable);
  assert.equal(JSON.parse(output.getStdout()).error.code, "EASYCONNECT_AGENT_SERVER_STOPPING");
});

test("runCli relaunches hidden Workbench after an EPIPE shutdown race", async () => {
  const output = createOutput();
  let attempt = 0;
  let launched = false;
  const code = await runCli(["--json", "status"], {
    ...output,
    async sendCommand() {
      attempt += 1;
      if (attempt === 1) {
        const error = new Error("write EPIPE");
        error.code = "EPIPE";
        error.agentTransport = true;
        throw error;
      }
      return createHealthyResult("status");
    },
    async launchWorkbench() {
      launched = true;
    },
    async waitForReady() {},
  });

  assert.equal(code, EXIT_CODES.ok);
  assert.equal(launched, true);
  assert.equal(attempt, 2);
});

test("runCli does not retry a business error that happens to use EPIPE", async () => {
  const output = createOutput();
  let attempts = 0;
  let launched = false;
  const code = await runCli(["--json", "ensure"], {
    ...output,
    async sendCommand() {
      attempts += 1;
      const error = new Error("business operation rejected the pipe target");
      error.code = "EPIPE";
      throw error;
    },
    async launchWorkbench() {
      launched = true;
    },
    async waitForReady() {},
  });

  assert.equal(code, EXIT_CODES.operation);
  assert.equal(attempts, 1);
  assert.equal(launched, false);
});

test("runCli classifies any marked local transport failure as unavailable without a blind relaunch", async () => {
  const output = createOutput();
  let launched = false;
  const code = await runCli(["--json", "status"], {
    ...output,
    async sendCommand() {
      const error = new Error("connect EACCES");
      error.code = "EACCES";
      error.agentTransport = true;
      throw error;
    },
    async launchWorkbench() {
      launched = true;
    },
  });

  assert.equal(code, EXIT_CODES.unavailable);
  assert.equal(launched, false);
  assert.equal(JSON.parse(output.getStdout()).error.code, "EACCES");
});

test("runCli rejects an incomplete successful config result", async () => {
  const output = createOutput();
  const code = await runCli(["--json", "--no-launch", "config"], {
    ...output,
    async sendCommand() {
      return { command: "config" };
    },
  });

  assert.equal(code, EXIT_CODES.unavailable);
  const payload = JSON.parse(output.getStdout());
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, "EASYCONNECT_AGENT_PROTOCOL_INVALID");
});

test("runCli accepts a complete config result with valid gateway objects", async () => {
  const output = createOutput();
  const code = await runCli(["--json", "--no-launch", "config"], {
    ...output,
    async sendCommand() {
      return createConfigResult();
    },
  });

  assert.equal(code, EXIT_CODES.ok);
  assert.equal(JSON.parse(output.getStdout()).ok, true);
});

test("runCli rejects malformed gateway fields in a config result", async () => {
  for (const result of [
    createConfigResult({ lastKnownGateway: [] }),
    createConfigResult({ gateways: [null, "vpn.example.test"] }),
  ]) {
    const output = createOutput();
    const code = await runCli(["--json", "--no-launch", "config"], {
      ...output,
      async sendCommand() {
        return result;
      },
    });

    assert.equal(code, EXIT_CODES.unavailable);
    assert.equal(JSON.parse(output.getStdout()).error.code, "EASYCONNECT_AGENT_PROTOCOL_INVALID");
  }
});

test("runCli rejects successful command results that redefine the envelope status", async () => {
  const output = createOutput();
  const code = await runCli(["--json", "--no-launch", "status"], {
    ...output,
    async sendCommand() {
      return { command: "status", healthy: true, ok: false };
    },
  });

  assert.equal(code, EXIT_CODES.unavailable);
  const payload = JSON.parse(output.getStdout());
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, "EASYCONNECT_AGENT_PROTOCOL_INVALID");
});

test("launchInstalledWorkbench starts the exact app bundle outside Electron Node mode", async () => {
  const calls = [];
  const appPath = "/Applications/EasyConnect Workbench.app";

  await launchInstalledWorkbench({
    appPath,
    env: {
      PATH: "/usr/bin:/bin",
      ELECTRON_RUN_AS_NODE: "1",
    },
    spawnFn(command, args, options) {
      calls.push({ command, args, options });
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 0));
      return child;
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "/usr/bin/open");
  assert.deepEqual(calls[0].args, ["-gj", "-n", appPath, "--args", "--hidden"]);
  assert.equal(calls[0].options.env.PATH, "/usr/bin:/bin");
  assert.equal(calls[0].options.env.ELECTRON_RUN_AS_NODE, undefined);
});

test("launchInstalledWorkbench normalizes spawn errors as unavailable", async () => {
  await assert.rejects(
    launchInstalledWorkbench({
      spawnFn() {
        const child = new EventEmitter();
        queueMicrotask(() => {
          const error = new Error("spawn EACCES");
          error.code = "EACCES";
          child.emit("error", error);
        });
        return child;
      },
    }),
    (error) => {
      assert.equal(error.code, "EASYCONNECT_AGENT_LAUNCH_FAILED");
      assert.equal(error.causeCode, "EACCES");
      return true;
    },
  );
});

test("launchInstalledWorkbench bounds and terminates a stuck open process", async () => {
  let unreferenced = false;
  const signals = [];
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.unref = () => {
    unreferenced = true;
  };
  child.kill = (signal = "SIGTERM") => {
    signals.push(signal);
    if (signal === "SIGKILL") {
      child.signalCode = signal;
    }
    return true;
  };

  const startedAt = Date.now();
  await assert.rejects(
    launchInstalledWorkbench({
      timeoutMs: 20,
      spawnFn() {
        return child;
      },
    }),
    (error) => error?.code === "EASYCONNECT_AGENT_LAUNCH_TIMEOUT",
  );
  const elapsedMs = Date.now() - startedAt;
  assert.equal(unreferenced, true);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.ok(elapsedMs < 80, `launcher exceeded its total deadline: ${elapsedMs}ms`);
});

test("runCli does not launch when --no-launch is explicit", async () => {
  const output = createOutput();
  let launched = false;
  const code = await runCli(["--json", "--no-launch", "status"], {
    ...output,
    async sendCommand() {
      const error = new Error("connect ENOENT");
      error.code = "ENOENT";
      error.agentTransport = true;
      throw error;
    },
    async launchWorkbench() {
      launched = true;
    },
  });

  assert.equal(code, EXIT_CODES.unavailable);
  assert.equal(launched, false);
  const payload = JSON.parse(output.getStdout());
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, "ENOENT");
});

test("runCli classifies controller health and invocation errors for agents", async () => {
  const healthOutput = createOutput();
  const healthCode = await runCli(["--json", "ensure"], {
    ...healthOutput,
    async sendCommand() {
      const error = new Error("VPN data plane is unreachable");
      error.code = "EASYCONNECT_AGENT_VPN_UNHEALTHY";
      throw error;
    },
  });
  assert.equal(healthCode, EXIT_CODES.unhealthy);

  const usageOutput = createOutput();
  const usageCode = await runCli(["--json", "unknown"], usageOutput);
  assert.equal(usageCode, EXIT_CODES.usage);
  assert.equal(JSON.parse(usageOutput.getStdout()).error.code, "EASYCONNECT_CLI_USAGE");

  const launchOutput = createOutput();
  const launchCode = await runCli(["--json", "status"], {
    ...launchOutput,
    async sendCommand() {
      const error = new Error("connect ENOENT");
      error.code = "ENOENT";
      error.agentTransport = true;
      throw error;
    },
    async launchWorkbench() {
      const error = new Error("open failed");
      error.code = "EASYCONNECT_AGENT_LAUNCH_FAILED";
      throw error;
    },
  });
  assert.equal(launchCode, EXIT_CODES.unavailable);
});

test("runCli sends mutating commands without a false client deadline", async () => {
  const output = createOutput();
  const requests = [];
  const code = await runCli(["--json", "--no-launch", "ensure"], {
    ...output,
    async sendCommand(request) {
      requests.push(request);
      return createHealthyResult("ensure");
    },
  });

  assert.equal(code, EXIT_CODES.ok);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].timeoutMs, null);
});

test("runCli keeps startup probing inside the requested total deadline", async () => {
  const output = createOutput();
  const pingTimeouts = [];
  const launchTimeouts = [];
  let firstRequest = true;
  const startedAt = Date.now();
  const code = await runCli([
    "--json",
    "--startup-timeout-seconds",
    "0.01",
    "status",
  ], {
    ...output,
    async sendCommand(request) {
      if (firstRequest) {
        firstRequest = false;
        const error = new Error("connect ENOENT");
        error.code = "ENOENT";
        error.agentTransport = true;
        throw error;
      }
      pingTimeouts.push(request.timeoutMs);
      throw new Error("not ready");
    },
    async launchWorkbench(options) {
      launchTimeouts.push(options?.timeoutMs);
    },
  });
  const elapsedMs = Date.now() - startedAt;

  assert.equal(code, EXIT_CODES.unavailable);
  assert.equal(pingTimeouts.length >= 1, true);
  assert.equal(pingTimeouts.every((timeoutMs) => timeoutMs <= 10), true);
  assert.equal(launchTimeouts.length, 1);
  assert.equal(launchTimeouts[0] <= 10, true);
  assert.equal(elapsedMs < 100, true);
});
