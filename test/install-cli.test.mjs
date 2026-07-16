import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp as createFsTempDirectory,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";

import { installCliEntry, parseInstallArgs } from "../scripts/install-cli.mjs";

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

async function createFakeApp(root) {
  const appPath = path.join(root, "EasyConnect Workbench.app");
  const source = path.join(appPath, "Contents", "Resources", "bin", "easyconnect-vpn");
  const skillSource = path.join(appPath, "Contents", "Resources", "skills", "easyconnect-vpn-cli");
  await mkdir(path.dirname(source), { recursive: true });
  await writeFile(source, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(source, 0o755);
  await mkdir(skillSource, { recursive: true });
  await writeFile(path.join(skillSource, "SKILL.md"), "---\nname: easyconnect-vpn-cli\n---\n", "utf8");
  return { appPath, source, skillSource };
}

test("installCliEntry creates an idempotent symlink to the packaged command", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "easyconnect-cli-install-"));
  const { appPath, source, skillSource } = await createFakeApp(root);
  const binDir = path.join(root, "home", ".local", "bin");
  const skillRoot = path.join(root, "home", ".codex", "skills");

  const first = await installCliEntry({ appPath, binDir, skillRoot });
  const second = await installCliEntry({ appPath, binDir, skillRoot });

  assert.equal(first.installed, true);
  assert.equal(second.installed, false);
  assert.equal(second.reason, "already-installed");
  assert.equal(await readlink(path.join(binDir, "easyconnect-vpn")), source);
  assert.equal((await lstat(path.join(binDir, "easyconnect-vpn"))).isSymbolicLink(), true);
  assert.equal(await readlink(path.join(skillRoot, "easyconnect-vpn-cli")), skillSource);
  assert.equal((await lstat(path.join(skillRoot, "easyconnect-vpn-cli"))).isSymbolicLink(), true);
  assert.equal(first.skill.installed, true);
  assert.equal(second.skill.reason, "already-installed");
});

test("installCliEntry refuses to replace a regular file without force", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "easyconnect-cli-conflict-"));
  const { appPath } = await createFakeApp(root);
  const binDir = path.join(root, "bin");
  const skillRoot = path.join(root, "skills");
  await mkdir(binDir, { recursive: true });
  await writeFile(path.join(binDir, "easyconnect-vpn"), "user-owned\n", "utf8");

  await assert.rejects(
    installCliEntry({ appPath, binDir, skillRoot }),
    (error) => error?.code === "EASYCONNECT_CLI_INSTALL_CONFLICT",
  );
});

test("installCliEntry force-replaces an existing skill directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "easyconnect-cli-force-directory-"));
  const { appPath, skillSource } = await createFakeApp(root);
  const binDir = path.join(root, "bin");
  const skillRoot = path.join(root, "skills");
  const skillTarget = path.join(skillRoot, "easyconnect-vpn-cli");
  await mkdir(skillTarget, { recursive: true });
  await writeFile(path.join(skillTarget, "user-owned.txt"), "replace me\n", "utf8");

  const result = await installCliEntry({ appPath, binDir, skillRoot, force: true });

  assert.equal(result.installed, true);
  assert.equal(await readlink(skillTarget), skillSource);
  assert.equal((await lstat(skillTarget)).isSymbolicLink(), true);
});

test("installCliEntry refuses to replace the packaged command with a self-link", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "easyconnect-cli-self-command-"));
  const { appPath, source } = await createFakeApp(root);
  const binDir = path.dirname(source);
  const skillRoot = path.join(root, "skills");

  await assert.rejects(
    installCliEntry({ appPath, binDir, skillRoot, force: true }),
    (error) => error?.code === "EASYCONNECT_CLI_INSTALL_INVALID_TARGET",
  );

  assert.equal((await lstat(source)).isFile(), true);
});

test("installCliEntry rejects a case-only alias of the packaged command", async () => {
  const root = await mkdtemp(path.join(os.homedir(), ".easyconnect-cli-case-alias-"));
  const { appPath, source } = await createFakeApp(root);
  const aliasedSource = source.replace(/^\/Users\//, "/users/");
  assert.notEqual(aliasedSource, source);
  const [sourceEntry, aliasEntry] = await Promise.all([lstat(source), lstat(aliasedSource)]);
  assert.equal(aliasEntry.dev, sourceEntry.dev);
  assert.equal(aliasEntry.ino, sourceEntry.ino);

  await assert.rejects(
    installCliEntry({
      appPath,
      binDir: path.dirname(aliasedSource),
      skillRoot: path.join(root, "skills"),
      force: true,
    }),
    (error) => error?.code === "EASYCONNECT_CLI_INSTALL_INVALID_TARGET",
  );

  assert.equal((await lstat(source)).isFile(), true);
});

test("installCliEntry refuses to replace the packaged skill with a self-link", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "easyconnect-cli-self-skill-"));
  const { appPath, skillSource } = await createFakeApp(root);
  const binDir = path.join(root, "bin");
  const skillRoot = path.dirname(skillSource);

  await assert.rejects(
    installCliEntry({ appPath, binDir, skillRoot, force: true }),
    (error) => error?.code === "EASYCONNECT_CLI_INSTALL_INVALID_TARGET",
  );

  assert.equal((await lstat(skillSource)).isDirectory(), true);
});

test("installCliEntry rejects a packaged command reached through a parent symlink", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "easyconnect-cli-aliased-command-"));
  const { appPath, source } = await createFakeApp(root);
  const aliasedBinDir = path.join(root, "bin-alias");
  await symlink(path.dirname(source), aliasedBinDir);

  await assert.rejects(
    installCliEntry({
      appPath,
      binDir: aliasedBinDir,
      skillRoot: path.join(root, "skills"),
      force: true,
    }),
    (error) => error?.code === "EASYCONNECT_CLI_INSTALL_INVALID_TARGET",
  );

  assert.equal((await lstat(source)).isFile(), true);
});

test("installCliEntry rejects a packaged skill reached through a parent symlink", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "easyconnect-cli-aliased-skill-"));
  const { appPath, skillSource } = await createFakeApp(root);
  const aliasedSkillRoot = path.join(root, "skill-alias");
  await symlink(path.dirname(skillSource), aliasedSkillRoot);

  await assert.rejects(
    installCliEntry({
      appPath,
      binDir: path.join(root, "bin"),
      skillRoot: aliasedSkillRoot,
      force: true,
    }),
    (error) => error?.code === "EASYCONNECT_CLI_INSTALL_INVALID_TARGET",
  );

  assert.equal((await lstat(skillSource)).isDirectory(), true);
});

test("installCliEntry rejects a target directory that contains the packaged source", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "easyconnect-cli-containing-target-"));
  const binDir = path.join(root, "bin");
  const cliTarget = path.join(binDir, "easyconnect-vpn");
  const { appPath, source } = await createFakeApp(cliTarget);

  await assert.rejects(
    installCliEntry({
      appPath,
      binDir,
      skillRoot: path.join(root, "skills"),
      force: true,
    }),
    (error) => error?.code === "EASYCONNECT_CLI_INSTALL_INVALID_TARGET",
  );

  assert.equal((await lstat(source)).isFile(), true);
});

test("installCliEntry rejects a target nested inside the packaged skill source", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "easyconnect-cli-nested-target-"));
  const { appPath, skillSource } = await createFakeApp(root);

  await assert.rejects(
    installCliEntry({
      appPath,
      binDir: path.join(root, "bin"),
      skillRoot: skillSource,
      force: true,
    }),
    (error) => error?.code === "EASYCONNECT_CLI_INSTALL_INVALID_TARGET",
  );

  assert.equal((await lstat(skillSource)).isDirectory(), true);
});

test("installCliEntry recognizes dot-dot-prefixed names as nested source paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "easyconnect-cli-dotdot-name-"));
  const { appPath, skillSource } = await createFakeApp(root);

  await assert.rejects(
    installCliEntry({
      appPath,
      binDir: path.join(root, "bin"),
      skillRoot: path.join(skillSource, "..cache"),
      force: true,
    }),
    (error) => error?.code === "EASYCONNECT_CLI_INSTALL_INVALID_TARGET",
  );
});

test("installCliEntry canonicalizes a symlink target's parent before mutation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "easyconnect-cli-symlink-parent-"));
  const { appPath, skillSource } = await createFakeApp(root);
  const aliasedSkillRoot = path.join(root, "skill-root-alias");
  const originalTarget = path.join(root, "original-target");
  const nestedTarget = path.join(skillSource, "easyconnect-vpn-cli");
  await mkdir(originalTarget, { recursive: true });
  await symlink(originalTarget, nestedTarget);
  await symlink(skillSource, aliasedSkillRoot);

  await assert.rejects(
    installCliEntry({
      appPath,
      binDir: path.join(root, "bin"),
      skillRoot: aliasedSkillRoot,
      force: true,
    }),
    (error) => error?.code === "EASYCONNECT_CLI_INSTALL_INVALID_TARGET",
  );

  assert.equal(await readlink(nestedTarget), originalTarget);
});

test("installCliEntry force-replaces a looping command symlink", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "easyconnect-cli-loop-link-"));
  const { appPath, source } = await createFakeApp(root);
  const binDir = path.join(root, "bin");
  const target = path.join(binDir, "easyconnect-vpn");
  await mkdir(binDir, { recursive: true });
  await symlink("easyconnect-vpn", target);

  await installCliEntry({
    appPath,
    binDir,
    skillRoot: path.join(root, "skills"),
    force: true,
  });

  assert.equal(await readlink(target), source);
});

test("installCliEntry rejects overlapping CLI and skill targets before applying either", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "easyconnect-cli-overlapping-targets-"));
  const { appPath, source } = await createFakeApp(root);
  const skillRoot = path.join(root, "install-skills");
  const skillTarget = path.join(skillRoot, "easyconnect-vpn-cli");
  const binDir = path.join(skillTarget, "bin");
  await mkdir(skillTarget, { recursive: true });

  await assert.rejects(
    installCliEntry({ appPath, binDir, skillRoot, force: true }),
    (error) => error?.code === "EASYCONNECT_CLI_INSTALL_INVALID_TARGET",
  );

  await assert.rejects(lstat(path.join(binDir, "easyconnect-vpn")), (error) => error?.code === "ENOENT");
  assert.equal((await lstat(source)).isFile(), true);
});

test("installCliEntry force-replaces a broken command symlink with an ENOTDIR target", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "easyconnect-cli-notdir-link-"));
  const { appPath, source } = await createFakeApp(root);
  const binDir = path.join(root, "bin");
  const target = path.join(binDir, "easyconnect-vpn");
  const ordinaryFile = path.join(root, "ordinary-file");
  await mkdir(binDir, { recursive: true });
  await writeFile(ordinaryFile, "not a directory\n", "utf8");
  await symlink(path.join(ordinaryFile, "child"), target);

  await installCliEntry({
    appPath,
    binDir,
    skillRoot: path.join(root, "skills"),
    force: true,
  });

  assert.equal(await readlink(target), source);
});

test("installCliEntry reports a clean mixed result when only the skill is installed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "easyconnect-cli-mixed-"));
  const { appPath, source } = await createFakeApp(root);
  const binDir = path.join(root, "bin");
  const skillRoot = path.join(root, "skills");
  await mkdir(binDir, { recursive: true });
  await symlink(source, path.join(binDir, "easyconnect-vpn"));

  const result = await installCliEntry({ appPath, binDir, skillRoot });

  assert.equal(result.installed, true);
  assert.equal(result.reason, undefined);
  assert.equal(result.skill.installed, true);
});

test("installCliEntry resolves a relative app path before creating links", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "easyconnect-cli-relative-app-"));
  const { appPath, source, skillSource } = await createFakeApp(root);
  const binDir = path.join(root, "bin");
  const skillRoot = path.join(root, "skills");
  const relativeAppPath = path.relative(process.cwd(), appPath);

  await installCliEntry({ appPath: relativeAppPath, binDir, skillRoot });

  assert.equal(await readlink(path.join(binDir, "easyconnect-vpn")), source);
  assert.equal(await readlink(path.join(skillRoot, "easyconnect-vpn-cli")), skillSource);
});

test("parseInstallArgs rejects missing option values before force installation", () => {
  assert.throws(
    () => parseInstallArgs(["--force", "--bin-dir"]),
    (error) => error?.code === "EASYCONNECT_CLI_INSTALL_USAGE",
  );
  assert.throws(
    () => parseInstallArgs(["--bin-dir", "--force"]),
    (error) => error?.code === "EASYCONNECT_CLI_INSTALL_USAGE",
  );
  assert.throws(
    () => parseInstallArgs(["--bin-dir", "-x"]),
    (error) => error?.code === "EASYCONNECT_CLI_INSTALL_USAGE",
  );
});
