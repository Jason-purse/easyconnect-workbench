import { access, cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const electronApp = path.join(projectRoot, "node_modules", "electron", "dist", "Electron.app");
const externalEasyConnectApp = "/Applications/EasyConnect.app/Contents/MacOS/EasyConnect";
const distDir = path.join(projectRoot, "dist.noindex");
const appName = "EasyConnect Workbench.app";
const appExecutableName = "EasyConnect Workbench";
const appBundle = path.join(distDir, appName);
const resourcesDir = path.join(appBundle, "Contents", "Resources");
const bundledWorkbenchDir = path.join(resourcesDir, "app");

async function assertExists(target, message) {
  try {
    await access(target);
  } catch {
    throw new Error(`${message}: ${target}`);
  }
}

function setPlistString(plist, key, value) {
  const pattern = new RegExp(`(<key>${key}</key>\\s*<string>)([^<]*)(</string>)`);
  if (pattern.test(plist)) {
    return plist.replace(pattern, `$1${value}$3`);
  }

  return plist.replace(
    "</dict>",
    `  <key>${key}</key>\n  <string>${value}</string>\n</dict>`,
  );
}

async function copyAppPayload() {
  await mkdir(bundledWorkbenchDir, { recursive: true });
  await cp(path.join(projectRoot, "package.json"), path.join(bundledWorkbenchDir, "package.json"));
  await cp(path.join(projectRoot, "src"), path.join(bundledWorkbenchDir, "src"), {
    recursive: true,
  });
}

async function updateBundlePlist() {
  const plistPath = path.join(appBundle, "Contents", "Info.plist");
  let plist = await readFile(plistPath, "utf8");

  plist = setPlistString(plist, "CFBundleName", "EasyConnect Workbench");
  plist = setPlistString(plist, "CFBundleDisplayName", "EasyConnect Workbench");
  plist = setPlistString(plist, "CFBundleIdentifier", "local.easyconnect.workbench");
  plist = setPlistString(plist, "CFBundleShortVersionString", "0.1.0");
  plist = setPlistString(plist, "CFBundleVersion", "0.1.0");
  plist = setPlistString(plist, "CFBundleExecutable", appExecutableName);

  await writeFile(plistPath, plist);
}

async function renameBundleExecutable() {
  const macOSDir = path.join(appBundle, "Contents", "MacOS");
  const electronExecutable = path.join(macOSDir, "Electron");
  const appExecutable = path.join(macOSDir, appExecutableName);

  await rm(appExecutable, { force: true });
  await rename(electronExecutable, appExecutable);
}

async function main() {
  await assertExists(electronApp, "Electron.app is missing; run npm install first");

  await mkdir(distDir, { recursive: true });
  await rm(appBundle, { recursive: true, force: true });
  await cp(electronApp, appBundle, {
    recursive: true,
    verbatimSymlinks: true,
  });
  await rm(bundledWorkbenchDir, { recursive: true, force: true });
  await copyAppPayload();
  await renameBundleExecutable();
  await updateBundlePlist();

  console.log(`Packaged ${appBundle}`);
  console.log(`Bundle executable: ${path.join(appBundle, "Contents", "MacOS", appExecutableName)}`);
  console.log(`External EasyConnect app is not bundled; expected path: ${externalEasyConnectApp}`);
}

main().catch((error) => {
  console.error(error?.stack ?? error?.message ?? String(error));
  process.exitCode = 1;
});
