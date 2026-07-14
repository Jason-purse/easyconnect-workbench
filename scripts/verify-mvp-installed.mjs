import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const distApp = path.join(projectRoot, "dist.noindex", "EasyConnect Workbench.app");
const installedApp = "/Applications/EasyConnect Workbench.app";
const stagedApp = `${installedApp}.installing`;
const installedExecutable = path.join(installedApp, "Contents", "MacOS", "EasyConnect Workbench");
const stagedExecutable = path.join(stagedApp, "Contents", "MacOS", "EasyConnect Workbench");
const installedAppNeedle = `${installedApp}/`;
const packagedAppNeedle = `${distApp}/`;
const configPath = path.join(
  process.env.HOME,
  "Library",
  "Application Support",
  "easyconnect-workbench",
  "config.json",
);
const workbenchProcessNeedles = [
  installedExecutable,
  installedAppNeedle,
  path.join(distApp, "Contents", "MacOS", "EasyConnect Workbench"),
  packagedAppNeedle,
  path.join(projectRoot, "node_modules", ".bin", "electron"),
  path.join(projectRoot, "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron"),
];

function gatewayKey(gateway) {
  const host = `${gateway?.host ?? ""}`.trim();
  const port = Number.parseInt(`${gateway?.port ?? ""}`, 10) || "";
  return host && port ? `${host}:${port}` : null;
}

function parseGatewayKeys(value) {
  return `${value ?? ""}`
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => item.includes(":"));
}

async function readConfiguredGatewayKeys() {
  try {
    const config = JSON.parse(await readFile(configPath, "utf8"));
    return (Array.isArray(config.vpn?.gateways) ? config.vpn.gateways : [])
      .map(gatewayKey)
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function loadAllowedGateways() {
  const envGateways = parseGatewayKeys(process.env.EASYCONNECT_VERIFY_GATEWAYS);
  const allowedGateways = envGateways.length > 0 ? envGateways : await readConfiguredGatewayKeys();

  if (allowedGateways.length === 0) {
    throw new Error(
      "No VPN gateways configured. Set EASYCONNECT_VERIFY_GATEWAYS=host:port[,host:port] or save gateways in Workbench first.",
    );
  }

  return [...new Set(allowedGateways)];
}

function log(event, payload = {}) {
  console.log(JSON.stringify({ event, ...payload }));
}

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function run(command, args = [], options = {}) {
  log("run", { command, args });

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? projectRoot,
      env: process.env,
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} ${args.join(" ")} failed with ${signal ?? `exit ${code}`}`));
    });
  });
}

function requestJson(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      let body = "";

      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`HTTP ${response.statusCode} for ${url}`));
          return;
        }

        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`Request timed out for ${url}`));
    });
    request.on("error", reject);
  });
}

function capture(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? projectRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(new Error(`${command} ${args.join(" ")} failed with ${signal ?? `exit ${code}`}: ${stderr}`));
    });
  });
}

async function captureOrEmpty(command, args = [], options = {}) {
  try {
    return await capture(command, args, options);
  } catch (error) {
    log("capture-skip", {
      command,
      args,
      reason: error?.message ?? String(error),
    });
    return { stdout: "", stderr: "" };
  }
}

function parsePid(processLine) {
  const match = processLine.trim().match(/^(\d+)/);
  return match ? Number.parseInt(match[1], 10) : null;
}

function isWorkbenchProcessLine(line) {
  return workbenchProcessNeedles.some((needle) => needle && line.includes(needle));
}

async function listWorkbenchProcesses() {
  const { stdout } = await captureOrEmpty("/bin/ps", ["-axo", "pid,ppid,lstart,etime,time,%cpu,%mem,command"]);
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter(isWorkbenchProcessLine);
}

async function waitForNoWorkbenchProcesses(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let processes = await listWorkbenchProcesses();

  while (processes.length > 0 && Date.now() < deadline) {
    await sleep(500);
    processes = await listWorkbenchProcesses();
  }

  return processes;
}

async function signalWorkbenchProcesses(processes, signal) {
  const pids = processes
    .map(parsePid)
    .filter((pid) => Number.isInteger(pid) && pid > 0)
    .map(String);

  if (pids.length === 0) {
    return;
  }

  await run("/bin/kill", [`-${signal}`, ...pids]).catch((error) => {
    log("stop-workbench-signal-skip", {
      signal,
      pids,
      reason: error?.message ?? String(error),
    });
  });
}

async function stopInstalledWorkbench() {
  log("stop-workbench-start");
  await run("/usr/bin/osascript", [
    "-e",
    'tell application "System Events" to set appIsRunning to exists process "EasyConnect Workbench"',
    "-e",
    'if appIsRunning then tell application "EasyConnect Workbench" to quit',
  ]).catch((error) => {
    log("stop-workbench-graceful-skip", { reason: error?.message ?? String(error) });
  });

  let remaining = await waitForNoWorkbenchProcesses(8000);
  if (remaining.length === 0) {
    log("stop-workbench-ok", { mode: "graceful" });
    return;
  }

  log("stop-workbench-force", { signal: "TERM", processes: remaining });
  await signalWorkbenchProcesses(remaining, "TERM");
  remaining = await waitForNoWorkbenchProcesses(5000);
  if (remaining.length === 0) {
    log("stop-workbench-ok", { mode: "term" });
    return;
  }

  log("stop-workbench-force", { signal: "KILL", processes: remaining });
  await signalWorkbenchProcesses(remaining, "KILL");
  remaining = await waitForNoWorkbenchProcesses(5000);
  if (remaining.length > 0) {
    throw new Error(`Workbench processes are still running: ${remaining.join(" | ")}`);
  }

  log("stop-workbench-ok", { mode: "kill" });
}

async function replaceInstalledWorkbench() {
  await rm(stagedApp, { recursive: true, force: true });
  await run("/usr/bin/ditto", [distApp, stagedApp]);

  if (!(await exists(stagedExecutable))) {
    await rm(stagedApp, { recursive: true, force: true });
    throw new Error(`Staged executable is missing: ${stagedExecutable}`);
  }

  await rm(installedApp, { recursive: true, force: true });
  await rename(stagedApp, installedApp);
  log("install-replaced", { installedApp });
}

function parseAllowedGatewayFromText(text, allowedGateways) {
  for (const gateway of allowedGateways) {
    const [host, port] = gateway.split(":");
    if (text.includes(host) && text.includes(port)) {
      return { host, port: Number.parseInt(port, 10) };
    }
  }

  return null;
}

async function detectCurrentAllowedGateway(allowedGateways) {
  const { stdout } = await capture("/bin/ps", ["-axo", "command"]);
  const csClientLine = stdout.split("\n").find((line) => line.includes("CSClient"));
  const csClientGateway = csClientLine ? parseAllowedGatewayFromText(csClientLine, allowedGateways) : null;
  if (csClientGateway) {
    return {
      source: "CSClient",
      gateway: csClientGateway,
    };
  }

  try {
    const targets = await requestJson("http://127.0.0.1:9222/json/list");
    for (const target of targets) {
      const targetGateway = parseAllowedGatewayFromText(`${target?.url ?? ""}`, allowedGateways);
      if (targetGateway) {
        return {
          source: "official-ui",
          gateway: targetGateway,
        };
      }
    }
  } catch (error) {
    log("gateway-detect-skip", { reason: error.message });
  }

  return null;
}

async function alignLastKnownGatewayWithCurrentState(allowedGateways) {
  const detected = await detectCurrentAllowedGateway(allowedGateways);
  if (!detected) {
    log("gateway-align-skip", { reason: "no current allowed gateway detected" });
    return;
  }

  const config = JSON.parse(await readFile(configPath, "utf8"));
  const gateways = (Array.isArray(config.vpn?.gateways) ? config.vpn.gateways : [])
    .map(gatewayKey)
    .filter(Boolean);
  const currentGateway = gatewayKey(detected.gateway);

  if (!gateways.includes(currentGateway)) {
    log("gateway-align-skip", {
      reason: "detected gateway is not configured",
      source: detected.source,
      gateway: currentGateway,
    });
    return;
  }

  config.vpn = {
    ...(config.vpn ?? {}),
    lastKnownGateway: detected.gateway,
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  log("gateway-aligned", {
    source: detected.source,
    lastKnownGateway: currentGateway,
  });
}

async function verifyConfig(allowedGateways) {
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const lastKnownGateway = gatewayKey(config.vpn?.lastKnownGateway);
  const gateways = (Array.isArray(config.vpn?.gateways) ? config.vpn.gateways : [])
    .map(gatewayKey)
    .filter(Boolean);
  const invalidGateways = gateways.filter((gateway) => !allowedGateways.includes(gateway));

  if (!allowedGateways.includes(lastKnownGateway)) {
    throw new Error(`Unexpected lastKnownGateway: ${lastKnownGateway}`);
  }

  if (invalidGateways.length > 0) {
    throw new Error(`Unexpected persisted gateways: ${invalidGateways.join(", ")}`);
  }

  for (const gateway of allowedGateways) {
    if (!gateways.includes(gateway)) {
      throw new Error(`Missing configured gateway: ${gateway}`);
    }
  }

  log("config-ok", {
    lastKnownGateway,
    gateways,
    maintainerAutoStart: Boolean(config.vpn?.maintainerAutoStart),
  });
}

async function readWorkbenchCpu(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`Invalid Workbench pid: ${pid}`);
  }

  const { stdout } = await capture("/bin/ps", ["-p", String(pid), "-o", "%cpu="]);
  const value = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(value)) {
    throw new Error(`Unable to read Workbench CPU for pid ${pid}: ${stdout.trim()}`);
  }

  return value;
}

async function waitForWorkbenchCpuIdle(pid, options = {}) {
  const maxCpu = options.maxCpu ?? 5;
  const intervalMs = options.intervalMs ?? 2000;
  const sampleCount = options.sampleCount ?? 8;
  const requiredIdleSamples = options.requiredIdleSamples ?? 3;
  const samples = [];
  let idleStreak = 0;

  for (let index = 0; index < sampleCount; index += 1) {
    const cpu = await readWorkbenchCpu(pid);
    samples.push(cpu);

    if (cpu <= maxCpu) {
      idleStreak += 1;
      if (idleStreak >= requiredIdleSamples) {
        log("workbench-cpu-ok", { pid, samples, maxCpu });
        return cpu;
      }
    } else {
      idleStreak = 0;
    }

    await sleep(intervalMs);
  }

  throw new Error(`Workbench hidden CPU did not settle below ${maxCpu}: ${samples.join(", ")}`);
}

async function verifyProcesses(allowedGateways) {
  const { stdout } = await capture("/bin/ps", ["-axo", "pid,%cpu,%mem,command"]);
  const lines = stdout.split("\n");
  const workbenchLines = lines.filter((line) => line.includes(installedExecutable) && line.includes("--hidden"));
  const csClient = lines.find((line) => line.includes("CSClient") && allowedGateways.some((gateway) => {
    const [host, port] = gateway.split(":");
    return line.includes(`-h ${host}`) && line.includes(`-p ${port}`);
  }));
  const svpnservice = lines.filter((line) => line.includes("svpnservice"));

  if (workbenchLines.length === 0) {
    throw new Error("Installed Workbench hidden process is not running");
  }

  if (workbenchLines.length > 1) {
    throw new Error(`Multiple installed Workbench hidden processes are running: ${workbenchLines.map((line) => line.trim()).join(" | ")}`);
  }

  if (!csClient) {
    throw new Error("CSClient is not connected to an allowed gateway");
  }

  if (svpnservice.length === 0) {
    throw new Error("svpnservice is not running");
  }

  const workbench = workbenchLines[0];
  const workbenchPid = parsePid(workbench);
  const workbenchCpu = await waitForWorkbenchCpuIdle(workbenchPid);

  log("processes-ok", {
    workbench: workbench.trim(),
    workbenchCpu,
    csClient: csClient.trim(),
    svpnserviceCount: svpnservice.length,
  });
}

async function main() {
  log("verify-start", { projectRoot, installedApp });
  const allowedGateways = await loadAllowedGateways();
  log("verify-gateways", { allowedGateways });

  await run("npm", ["test"]);
  await run("npm", ["run", "package:mac"]);

  if (!(await exists(distApp))) {
    throw new Error(`Packaged app is missing: ${distApp}`);
  }

  await stopInstalledWorkbench();
  await alignLastKnownGatewayWithCurrentState(allowedGateways);
  await replaceInstalledWorkbench();

  if (!(await exists(installedExecutable))) {
    throw new Error(`Installed executable is missing: ${installedExecutable}`);
  }

  await run(installedExecutable, [
    "--smoke-vpn-autostart",
    "--smoke-ignore-quiet-hours",
    "--smoke-timeout-ms=120000",
  ]);
  await run(installedExecutable, [
    "--smoke-vpn-keepalive",
    "--smoke-ignore-quiet-hours",
    "--smoke-interval-seconds=10",
    "--smoke-timeout-ms=180000",
  ]);
  await run(installedExecutable, [
    "--smoke-vpn-offline-recovery",
    "--smoke-ignore-quiet-hours",
    "--smoke-interval-seconds=10",
    "--smoke-timeout-ms=180000",
  ]);
  await run(installedExecutable, [
    "--smoke-vpn-failure-state",
    "--smoke-ignore-quiet-hours",
    "--smoke-interval-seconds=10",
    "--smoke-restore-timeout-ms=300000",
    "--smoke-timeout-ms=180000",
  ]);

  await stopInstalledWorkbench();
  await run("/usr/bin/open", ["-na", installedApp, "--args", "--hidden"]);
  await new Promise((resolve) => setTimeout(resolve, 20000));

  await verifyConfig(allowedGateways);
  await verifyProcesses(allowedGateways);

  log("verify-complete", { ok: true });
}

main().catch((error) => {
  log("verify-error", { message: error?.message ?? String(error) });
  process.exitCode = 1;
});
