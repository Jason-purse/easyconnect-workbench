import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDir, "..");

async function listFiles(dirPath) {
  const entries = await readdir(dirPath, {
    withFileTypes: true,
  });
  const files = [];

  for (const entry of entries) {
    const itemPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(itemPath)));
    } else {
      files.push(itemPath);
    }
  }

  return files;
}

test("workbench imports EasyConnect bridge from internal source tree", async () => {
  const bridgeFiles = await listFiles(path.join(projectRoot, "src", "easyconnect-bridge"));
  assert.deepEqual(
    bridgeFiles.map((filePath) => path.basename(filePath)).sort(),
    ["login.mjs", "maintainer.mjs", "runtime.mjs"],
  );

  const sourceFiles = await listFiles(path.join(projectRoot, "src"));
  for (const filePath of sourceFiles) {
    const content = await readFile(filePath, "utf8");
    assert.equal(
      content.includes("easyconnect-runtime-poc"),
      false,
      `${path.relative(projectRoot, filePath)} must not import the sibling runtime poc`,
    );
  }

  const packageScript = await readFile(path.join(projectRoot, "scripts", "package-macos.mjs"), "utf8");
  assert.equal(packageScript.includes("easyconnect-runtime-poc"), false);
});
