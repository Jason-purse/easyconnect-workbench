#!/usr/bin/env node

import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  getAgentSocketPath,
  sendAgentCommand,
} from "../services/agent-command-channel.js";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_STARTUP_TIMEOUT_MS = 15 * 1000;
const LAUNCH_TERMINATION_GRACE_MS = 100;
const MAX_TIMEOUT_MS = 2_147_483_647;
const DEFAULT_USER_DATA_PATH = path.join(os.homedir(), "Library", "Application Support", "easyconnect-workbench");
const DEFAULT_APP_NAME = "EasyConnect Workbench";

export const EXIT_CODES = Object.freeze({
  ok: 0,
  operation: 1,
  usage: 2,
  unhealthy: 3,
  unavailable: 4,
});

const USAGE = `Usage:
  easyconnect-vpn [--json] [--no-launch] status [--timeout-seconds N]
  easyconnect-vpn [--json] ensure [--ignore-quiet-hours]
  easyconnect-vpn [--json] keepalive start [--ignore-quiet-hours]
  easyconnect-vpn [--json] keepalive stop
  easyconnect-vpn [--json] config [--timeout-seconds N]

Exit codes:
  0 ready/success, 1 operation failed, 2 invalid command, 3 VPN unhealthy, 4 Workbench unavailable`;

class CliUsageError extends Error {
  constructor(message) {
    super(message);
    this.code = "EASYCONNECT_CLI_USAGE";
  }
}

function parsePositiveSeconds(value, option) {
  const seconds = Number(`${value ?? ""}`);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new CliUsageError(`${option} requires a positive number of seconds`);
  }
  const milliseconds = Math.max(1, Math.round(seconds * 1000));
  if (!Number.isFinite(milliseconds) || milliseconds > MAX_TIMEOUT_MS) {
    throw new CliUsageError(`${option} exceeds the supported timeout range`);
  }
  return milliseconds;
}

export function parseCliArgs(argv = []) {
  const positional = [];
  let json = false;
  let launch = true;
  let ignoreQuietHours = false;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let timeoutSpecified = false;
  let startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--json") {
      json = true;
    } else if (value === "--no-launch") {
      launch = false;
    } else if (value === "--ignore-quiet-hours") {
      ignoreQuietHours = true;
    } else if (value === "--timeout-seconds") {
      timeoutMs = parsePositiveSeconds(argv[index + 1], value);
      timeoutSpecified = true;
      index += 1;
    } else if (value === "--startup-timeout-seconds") {
      startupTimeoutMs = parsePositiveSeconds(argv[index + 1], value);
      index += 1;
    } else if (value === "--help" || value === "-h") {
      help = true;
    } else if (value.startsWith("-")) {
      throw new CliUsageError(`Unknown option: ${value}`);
    } else {
      positional.push(value);
    }
  }

  if (help || positional.length === 0 || positional[0] === "help") {
    return {
      json,
      launch,
      timeoutMs,
      startupTimeoutMs,
      command: "help",
      options: {},
    };
  }

  let command = positional[0];
  if (command === "keepalive") {
    if (positional.length !== 2 || !["start", "stop"].includes(positional[1])) {
      throw new CliUsageError("keepalive requires start or stop");
    }
    command = `keepalive-${positional[1]}`;
  } else if (!["status", "ensure", "config"].includes(command) || positional.length !== 1) {
    throw new CliUsageError(`Unknown command: ${positional.join(" ")}`);
  }

  if (ignoreQuietHours && !["ensure", "keepalive-start"].includes(command)) {
    throw new CliUsageError("--ignore-quiet-hours is valid only for ensure or keepalive start");
  }
  const mutatingCommand = ["ensure", "keepalive-start", "keepalive-stop"].includes(command);
  if (timeoutSpecified && mutatingCommand) {
    throw new CliUsageError(
      "--timeout-seconds is valid only for read-only status or config commands",
    );
  }

  return {
    json,
    launch,
    timeoutMs: mutatingCommand ? null : timeoutMs,
    startupTimeoutMs,
    command,
    options: ignoreQuietHours ? { ignoreQuietHours: true } : {},
  };
}

function isSocketUnavailable(error) {
  if (["EASYCONNECT_AGENT_PROTOCOL_INVALID", "EASYCONNECT_AGENT_SERVER_STOPPING"].includes(error?.code)) {
    return true;
  }
  return error?.agentTransport === true;
}

function shouldLaunchWorkbench(error) {
  if (error?.code === "EASYCONNECT_AGENT_SERVER_STOPPING") {
    return true;
  }
  return error?.agentTransport === true && [
    "ENOENT",
    "ECONNREFUSED",
    "ECONNRESET",
    "EPIPE",
  ].includes(error?.code);
}

function classifyError(error) {
  if (error?.code === "EASYCONNECT_CLI_USAGE") {
    return EXIT_CODES.usage;
  }
  if (
    [
      "EASYCONNECT_AGENT_CONFIG_INCOMPLETE",
      "EASYCONNECT_AGENT_QUIET_HOURS",
      "EASYCONNECT_AGENT_VPN_UNHEALTHY",
    ].includes(error?.code)
  ) {
    return EXIT_CODES.unhealthy;
  }
  if (
    isSocketUnavailable(error) ||
    [
      "EASYCONNECT_AGENT_LAUNCH_FAILED",
      "EASYCONNECT_AGENT_LAUNCH_TIMEOUT",
      "EASYCONNECT_AGENT_STARTUP_TIMEOUT",
      "EASYCONNECT_AGENT_TIMEOUT",
    ].includes(error?.code)
  ) {
    return EXIT_CODES.unavailable;
  }
  return EXIT_CODES.operation;
}

function serializeCliError(error) {
  const result = {
    message: error?.message ?? String(error),
    code: error?.code ?? "EASYCONNECT_CLI_FAILED",
  };
  for (const field of ["reason", "quietHours", "dataPlane", "status", "activeKey"]) {
    if (error?.[field] !== undefined) {
      result[field] = error[field];
    }
  }
  return result;
}

function isValidGatewayResult(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof value.host === "string" &&
    value.host.trim() &&
    Number.isInteger(value.port) &&
    value.port > 0 &&
    value.port <= 65535,
  );
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isValidHealthResult(result) {
  if (typeof result.healthy !== "boolean") {
    return false;
  }
  const controlPlane = result.controlPlane;
  const dataPlane = result.dataPlane;
  if (
    !isRecord(controlPlane) ||
    typeof controlPlane.online !== "boolean" ||
    !isRecord(dataPlane) ||
    typeof dataPlane.configured !== "boolean" ||
    ![true, false, null].includes(dataPlane.ok)
  ) {
    return false;
  }
  const route = dataPlane.route;
  if (route !== null && (!isRecord(route) || typeof route.tunneled !== "boolean")) {
    return false;
  }
  return result.healthy !== true || (
    controlPlane.online === true &&
    dataPlane.configured === true &&
    dataPlane.ok === true &&
    route?.tunneled === true
  );
}

function validateCommandResult(result, expectedCommand) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    const error = new Error("EasyConnect agent command returned an invalid result");
    error.code = "EASYCONNECT_AGENT_PROTOCOL_INVALID";
    throw error;
  }
  const invalidCommand = result.command !== expectedCommand;
  const invalidEnvelope = Object.hasOwn(result, "ok");
  const invalidHealth =
    ["status", "ensure"].includes(expectedCommand) && !isValidHealthResult(result);
  const invalidMaintainer =
    ["keepalive-start", "keepalive-stop"].includes(expectedCommand) &&
    typeof result.running !== "boolean";
  const credentials = result.credentials;
  const quietHours = result.quietHours;
  const invalidConfig = expectedCommand === "config" && !(
    credentials &&
    typeof credentials === "object" &&
    !Array.isArray(credentials) &&
    typeof credentials.usernameConfigured === "boolean" &&
    typeof credentials.passwordConfigured === "boolean" &&
    (result.dataPlaneProbeTarget === null || typeof result.dataPlaneProbeTarget === "string") &&
    Number.isFinite(result.dataPlaneProbeTimeoutMs) &&
    result.dataPlaneProbeTimeoutMs > 0 &&
    typeof result.maintainerAutoStart === "boolean" &&
    Number.isFinite(result.maintainerIntervalSeconds) &&
    result.maintainerIntervalSeconds > 0 &&
    quietHours &&
    typeof quietHours === "object" &&
    !Array.isArray(quietHours) &&
    typeof quietHours.enabled === "boolean" &&
    typeof quietHours.start === "string" &&
    typeof quietHours.end === "string" &&
    (result.lastKnownGateway === null || isValidGatewayResult(result.lastKnownGateway)) &&
    Array.isArray(result.gateways) &&
    result.gateways.every(isValidGatewayResult)
  );
  if (invalidCommand || invalidEnvelope || invalidHealth || invalidMaintainer || invalidConfig) {
    const error = new Error(`EasyConnect agent returned an invalid ${expectedCommand} result`);
    error.code = "EASYCONNECT_AGENT_PROTOCOL_INVALID";
    throw error;
  }
  return result;
}

export function launchInstalledWorkbench({
  appPath = process.env.EASYCONNECT_WORKBENCH_APP_PATH || `/Applications/${DEFAULT_APP_NAME}.app`,
  env = process.env,
  spawnFn = spawn,
  timeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
} = {}) {
  const launchEnv = { ...env };
  delete launchEnv.ELECTRON_RUN_AS_NODE;

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnFn(
        "/usr/bin/open",
        ["-gj", "-n", appPath, "--args", "--hidden"],
        { stdio: "ignore", env: launchEnv },
      );
    } catch (cause) {
      const error = new Error(`Could not launch ${DEFAULT_APP_NAME}: ${cause?.message ?? String(cause)}`);
      error.code = "EASYCONNECT_AGENT_LAUNCH_FAILED";
      error.causeCode = cause?.code;
      reject(error);
      return;
    }

    let settled = false;
    let timedOut = false;
    let timeoutError = null;
    let forceKillTimer = null;
    const launchTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : DEFAULT_STARTUP_TIMEOUT_MS;
    const terminationGraceMs = Math.min(
      LAUNCH_TERMINATION_GRACE_MS,
      Math.max(0, launchTimeoutMs - 1),
    );
    const launchAttemptTimeoutMs = Math.max(1, launchTimeoutMs - terminationGraceMs);
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(forceKillTimer);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const finish = (handler, value) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      handler(value);
    };
    const onError = (cause) => {
      if (timedOut) {
        finish(reject, timeoutError);
        return;
      }
      const error = new Error(`Could not launch ${DEFAULT_APP_NAME}: ${cause?.message ?? String(cause)}`);
      error.code = "EASYCONNECT_AGENT_LAUNCH_FAILED";
      error.causeCode = cause?.code;
      finish(reject, error);
    };
    const onExit = (code) => {
      if (timedOut) {
        finish(reject, timeoutError);
        return;
      }
      if (code === 0) {
        finish(resolve);
        return;
      }
      const error = new Error(`Could not launch ${DEFAULT_APP_NAME}; open exited ${code}`);
      error.code = "EASYCONNECT_AGENT_LAUNCH_FAILED";
      finish(reject, error);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      timeoutError = new Error(
        `Could not launch ${DEFAULT_APP_NAME} within ${launchTimeoutMs}ms`,
      );
      timeoutError.code = "EASYCONNECT_AGENT_LAUNCH_TIMEOUT";
      try {
        child.kill?.("SIGTERM");
      } catch {
        // The timeout result remains authoritative even if the launcher cannot be terminated.
      }
      if (settled) {
        return;
      }
      forceKillTimer = setTimeout(() => {
        if (child.exitCode !== null || child.signalCode !== null) {
          finish(reject, timeoutError);
          return;
        }
        try {
          child.kill?.("SIGKILL");
        } catch {
          // The detached launcher must not survive the bounded termination grace period.
        }
        finish(reject, timeoutError);
      }, terminationGraceMs);
    }, launchAttemptTimeoutMs);
    child.once("error", onError);
    child.once("exit", onExit);
    child.unref?.();
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForAgentReady({ sendCommand, socketPath, startupTimeoutMs }) {
  const deadline = Date.now() + startupTimeoutMs;
  let lastError = null;
  while (true) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      break;
    }
    try {
      await sendCommand({
        socketPath,
        command: "ping",
        options: {},
        timeoutMs: Math.min(1000, remainingMs),
      });
      return;
    } catch (error) {
      lastError = error;
      const retryDelayMs = Math.min(200, deadline - Date.now());
      if (retryDelayMs > 0) {
        await delay(retryDelayMs);
      }
    }
  }

  const error = new Error(
    `EasyConnect Workbench did not expose its agent socket within ${startupTimeoutMs}ms${
      lastError?.message ? `: ${lastError.message}` : ""
    }`,
  );
  error.code = "EASYCONNECT_AGENT_STARTUP_TIMEOUT";
  throw error;
}

function formatHumanResult(result) {
  if (result.command === "status" || result.command === "ensure") {
    const dataPlane = result.dataPlane ?? {};
    return [
      `VPN: ${result.healthy ? "ready" : "unhealthy"} (${result.reason ?? "unknown"})`,
      `Session: ${result.controlPlane?.sessionId ?? "-"}`,
      `Data plane: ${dataPlane.state ?? "unknown"} via ${dataPlane.route?.interface ?? "-"}`,
      `Keepalive: ${(result.keepalive ?? result.maintainer)?.running ? "running" : "stopped"}`,
    ].join("\n");
  }
  return JSON.stringify(result, null, 2);
}

function writeResult(stream, value) {
  stream.write(`${value}\n`);
}

export async function runCli(argv = [], dependencies = {}) {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const jsonRequested = argv.includes("--json");
  let parsed;

  try {
    parsed = parseCliArgs(argv);
  } catch (error) {
    const payload = { ok: false, error: serializeCliError(error) };
    writeResult(jsonRequested ? stdout : stderr, jsonRequested ? JSON.stringify(payload) : `${error.message}\n\n${USAGE}`);
    return EXIT_CODES.usage;
  }

  if (parsed.command === "help") {
    writeResult(
      stdout,
      parsed.json ? JSON.stringify({ ok: true, command: "help", usage: USAGE }) : USAGE,
    );
    return EXIT_CODES.ok;
  }

  const socketPath =
    dependencies.socketPath ??
    process.env.EASYCONNECT_WORKBENCH_SOCKET ??
    getAgentSocketPath(process.env.EASYCONNECT_WORKBENCH_USER_DATA ?? DEFAULT_USER_DATA_PATH);
  const sendCommand = dependencies.sendCommand ?? sendAgentCommand;
  const launchWorkbench = dependencies.launchWorkbench ?? launchInstalledWorkbench;
  const waitForReady =
    dependencies.waitForReady ??
    ((startupTimeoutMs) => waitForAgentReady({ sendCommand, socketPath, startupTimeoutMs }));
  const request = {
    socketPath,
    command: parsed.command,
    options: parsed.options,
    timeoutMs: parsed.timeoutMs,
  };

  try {
    let result;
    try {
      result = validateCommandResult(await sendCommand(request), parsed.command);
    } catch (error) {
      if (!parsed.launch || !shouldLaunchWorkbench(error)) {
        throw error;
      }
      const startupDeadline = Date.now() + parsed.startupTimeoutMs;
      await launchWorkbench({ timeoutMs: Math.max(1, startupDeadline - Date.now()) });
      const readyTimeoutMs = startupDeadline - Date.now();
      if (readyTimeoutMs <= 0) {
        const timeoutError = new Error(
          `EasyConnect Workbench did not expose its agent socket within ${parsed.startupTimeoutMs}ms`,
        );
        timeoutError.code = "EASYCONNECT_AGENT_STARTUP_TIMEOUT";
        throw timeoutError;
      }
      await waitForReady(readyTimeoutMs);
      result = validateCommandResult(await sendCommand(request), parsed.command);
    }

    const payload = { ...result, ok: true };
    writeResult(stdout, parsed.json ? JSON.stringify(payload) : formatHumanResult(result));
    const unsuccessful =
      result.healthy === false ||
      (parsed.command === "keepalive-start" && result.running !== true) ||
      (parsed.command === "keepalive-stop" && result.running !== false);
    return unsuccessful ? EXIT_CODES.unhealthy : EXIT_CODES.ok;
  } catch (error) {
    const payload = { ok: false, error: serializeCliError(error) };
    writeResult(parsed.json ? stdout : stderr, parsed.json ? JSON.stringify(payload) : error.message);
    return classifyError(error);
  }
}

const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isEntrypoint) {
  process.exitCode = await runCli(process.argv.slice(2));
}
