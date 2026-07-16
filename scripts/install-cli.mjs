import { constants } from "node:fs";
import { access, lstat, mkdir, readlink, realpath, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_APP_PATH = "/Applications/EasyConnect Workbench.app";
const DEFAULT_BIN_DIR = path.join(os.homedir(), ".local", "bin");
const DEFAULT_SKILL_ROOT = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "skills");

function createConflictError(target) {
  const error = new Error(`Refusing to replace existing CLI entry without --force: ${target}`);
  error.code = "EASYCONNECT_CLI_INSTALL_CONFLICT";
  return error;
}

function createInvalidTargetError(source, target) {
  const error = new Error(`Refusing a CLI target that overlaps its packaged source: ${target}`);
  error.code = "EASYCONNECT_CLI_INSTALL_INVALID_TARGET";
  error.source = source;
  error.target = target;
  return error;
}

function isSameOrNestedPath(parent, candidate) {
  const relative = path.relative(parent, candidate);
  const leavesParent = relative === ".." || relative.startsWith(`..${path.sep}`);
  return relative === "" || (!leavesParent && !path.isAbsolute(relative));
}

function pathsOverlap(first, second) {
  return isSameOrNestedPath(first, second) || isSameOrNestedPath(second, first);
}

async function resolveMissingTarget(target) {
  const suffix = [path.basename(target)];
  let ancestor = path.dirname(target);
  while (true) {
    try {
      return path.join(await realpath(ancestor), ...suffix);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) {
        return path.resolve(target);
      }
      suffix.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
}

async function resolveMutationPath(target) {
  const existing = await getExistingEntry(target);
  if (existing?.isSymbolicLink()) {
    return resolveMissingTarget(target);
  }
  return existing ? realpath(target) : resolveMissingTarget(target);
}

async function assertInstallPathsIndependent({ sources, targets }) {
  const canonicalSources = await Promise.all(sources.map((source) => realpath(source)));
  const mutationTargets = await Promise.all(targets.map((target) => resolveMutationPath(target)));

  for (let targetIndex = 0; targetIndex < mutationTargets.length; targetIndex += 1) {
    for (const source of canonicalSources) {
      if (pathsOverlap(source, mutationTargets[targetIndex])) {
        throw createInvalidTargetError(source, targets[targetIndex]);
      }
    }
  }
  if (pathsOverlap(mutationTargets[0], mutationTargets[1])) {
    throw createInvalidTargetError(mutationTargets[0], mutationTargets[1]);
  }
}

async function getExistingEntry(target) {
  try {
    return await lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function prepareLink({ source, target, force }) {
  const resolvedSource = path.resolve(source);
  const resolvedTarget = path.resolve(target);
  if (pathsOverlap(resolvedSource, resolvedTarget)) {
    throw createInvalidTargetError(source, target);
  }
  const existing = await getExistingEntry(target);
  const canonicalSource = await realpath(source);
  if (existing?.isSymbolicLink()) {
    const currentTarget = await readlink(target);
    if (path.resolve(path.dirname(target), currentTarget) === resolvedSource) {
      return { action: "keep", source, target };
    }
    try {
      if (await realpath(target) === canonicalSource) {
        return { action: "keep", source, target };
      }
    } catch (error) {
      if (!["ENOENT", "ELOOP", "ENOTDIR"].includes(error?.code)) {
        throw error;
      }
    }
  } else {
    const canonicalTarget = existing ? await realpath(target) : await resolveMissingTarget(target);
    if (pathsOverlap(canonicalSource, canonicalTarget)) {
      throw createInvalidTargetError(source, target);
    }
  }
  if (existing && !force) {
    throw createConflictError(target);
  }
  return { action: existing ? "replace" : "create", source, target };
}

async function applyLink(plan) {
  if (plan.action === "keep") {
    return {
      installed: false,
      reason: "already-installed",
      source: plan.source,
      target: plan.target,
    };
  }
  await mkdir(path.dirname(plan.target), { recursive: true });
  if (plan.action === "replace") {
    await rm(plan.target, { recursive: true, force: true });
  }
  await symlink(plan.source, plan.target);
  return {
    installed: true,
    source: plan.source,
    target: plan.target,
  };
}

export async function installCliEntry({
  appPath = DEFAULT_APP_PATH,
  binDir = DEFAULT_BIN_DIR,
  skillRoot = DEFAULT_SKILL_ROOT,
  force = false,
} = {}) {
  const resolvedAppPath = path.resolve(appPath);
  const cliSource = path.join(resolvedAppPath, "Contents", "Resources", "bin", "easyconnect-vpn");
  const cliTarget = path.join(path.resolve(binDir), "easyconnect-vpn");
  const skillSource = path.join(resolvedAppPath, "Contents", "Resources", "skills", "easyconnect-vpn-cli");
  const skillTarget = path.join(path.resolve(skillRoot), "easyconnect-vpn-cli");
  await access(cliSource, constants.X_OK);
  await access(path.join(skillSource, "SKILL.md"), constants.R_OK);

  await assertInstallPathsIndependent({
    sources: [cliSource, skillSource],
    targets: [cliTarget, skillTarget],
  });

  const cliPlan = await prepareLink({ source: cliSource, target: cliTarget, force });
  const skillPlan = await prepareLink({ source: skillSource, target: skillTarget, force });
  const cli = await applyLink(cliPlan);
  const skill = await applyLink(skillPlan);
  const installed = cli.installed || skill.installed;
  const { reason: cliReason, ...cliResult } = cli;
  return {
    ...cliResult,
    installed,
    ...(installed ? {} : { reason: cliReason ?? "already-installed" }),
    skill,
  };
}

function readOptionValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) {
    const error = new Error(`${option} requires a value`);
    error.code = "EASYCONNECT_CLI_INSTALL_USAGE";
    throw error;
  }
  return value;
}

export function parseInstallArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--app") {
      options.appPath = readOptionValue(argv, index, value);
      index += 1;
    } else if (value === "--bin-dir") {
      options.binDir = readOptionValue(argv, index, value);
      index += 1;
    } else if (value === "--skill-root") {
      options.skillRoot = readOptionValue(argv, index, value);
      index += 1;
    } else if (value === "--force") {
      options.force = true;
    } else {
      const error = new Error(`Unknown install option: ${value}`);
      error.code = "EASYCONNECT_CLI_INSTALL_USAGE";
      throw error;
    }
  }
  return options;
}

async function main() {
  const result = await installCliEntry(parseInstallArgs(process.argv.slice(2)));
  console.log(JSON.stringify({ ok: true, ...result }));
}

const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isEntrypoint) {
  main().catch((error) => {
    console.error(JSON.stringify({
      ok: false,
      error: {
        message: error?.message ?? String(error),
        code: error?.code ?? "EASYCONNECT_CLI_INSTALL_FAILED",
      },
    }));
    process.exitCode = 1;
  });
}
