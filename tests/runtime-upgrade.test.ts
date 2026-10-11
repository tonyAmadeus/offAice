import "../scripts/test-bootstrap.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
  symlink,
} from "node:fs/promises";

test("distribution upgrade preserves previously acquired CLIs, their dependency paths and user data while replacing app files", async () => {
  const root = path.resolve(".test-cache/runtime-upgrade");
  await mkdir(root, { recursive: true });
  const folder = await mkdtemp(path.join(root, "run-")),
    source = path.join(folder, "build"),
    target = path.join(folder, "installed");
  const file = async (base: string, name: string, text: string) => {
    const value = path.join(base, name);
    await mkdir(path.dirname(value), { recursive: true });
    await writeFile(value, text);
  };
  const runner = path.join(folder, "copy.ps1");
  await writeFile(
    runner,
    "param($Helper,$Build,$Runtime)\n$ErrorActionPreference='Stop'\n. $Helper\nCopy-AIROOMRuntime -Source $Build -Destination $Runtime\nexit 0\n",
  );
  try {
    await file(source, "resources/app/dist/main.mjs", "new app");
    await file(
      source,
      "resources/app/node_modules/npm/package.json",
      "new npm",
    );
    await file(target, "resources/app/dist/main.mjs", "old app");
    await file(target, "resources/app/dist/obsolete.mjs", "removed app code");
    await file(
      target,
      "resources/app/node_modules/@openai/codex/bin/codex.js",
      "unchanged official CLI",
    );
    await file(
      target,
      "resources/app/node_modules/old-cli-peer/index.js",
      "unchanged peer",
    );
    await file(
      target,
      "resources/app/node_modules/npm/docs/content.md",
      "obsolete help",
    );
    await file(
      target,
      "resources/app/node_modules/npm/man/npm.1",
      "obsolete manual",
    );
    await file(
      target,
      "resources/app/node_modules/npm/node_modules/old-peer/LICENSE",
      "unchanged nested package license",
    );
    await file(target, "data/airoom.sqlite", "unchanged user database");
    await file(
      target,
      "data/native/codex/auth.json",
      "unchanged isolated account",
    );
    await file(target, "Uninstall AIROOM.exe", "installed uninstaller");
    const copy = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        runner,
        path.resolve("scripts/copy-runtime.ps1"),
        source,
        target,
      ],
      { encoding: "utf8", timeout: 20_000, windowsHide: true },
    );
    assert.equal(copy.status, 0, copy.stderr);
    assert.equal(
      await readFile(path.join(target, "resources/app/dist/main.mjs"), "utf8"),
      "new app",
    );
    await assert.rejects(
      readFile(path.join(target, "resources/app/dist/obsolete.mjs")),
    );
    assert.equal(
      await readFile(
        path.join(target, "resources/app/node_modules/npm/package.json"),
        "utf8",
      ),
      "new npm",
    );
    await assert.rejects(
      readFile(
        path.join(target, "resources/app/node_modules/npm/docs/content.md"),
      ),
      { code: "ENOENT" },
    );
    await assert.rejects(
      readFile(path.join(target, "resources/app/node_modules/npm/man/npm.1")),
      { code: "ENOENT" },
    );
    assert.equal(
      await readFile(
        path.join(
          target,
          "resources/app/node_modules/npm/node_modules/old-peer/LICENSE",
        ),
        "utf8",
      ),
      "unchanged nested package license",
    );
    assert.equal(
      await readFile(
        path.join(
          target,
          "resources/app/node_modules/@openai/codex/bin/codex.js",
        ),
        "utf8",
      ),
      "unchanged official CLI",
    );
    assert.equal(
      await readFile(
        path.join(target, "resources/app/node_modules/old-cli-peer/index.js"),
        "utf8",
      ),
      "unchanged peer",
    );
    assert.equal(
      await readFile(path.join(target, "data/airoom.sqlite"), "utf8"),
      "unchanged user database",
    );
    assert.equal(
      await readFile(path.join(target, "data/native/codex/auth.json"), "utf8"),
      "unchanged isolated account",
    );
    assert.equal(
      await readFile(path.join(target, "Uninstall AIROOM.exe"), "utf8"),
      "installed uninstaller",
    );
  } finally {
    assert.equal(path.dirname(folder), root);
    await rm(folder, { recursive: true, force: true });
  }
});

test("documentation cleanup refuses a directory junction and preserves its external target", async () => {
  const root = path.resolve(".test-cache/runtime-upgrade");
  await mkdir(root, { recursive: true });
  const folder = await mkdtemp(path.join(root, "run-")),
    source = path.join(folder, "build"),
    target = path.join(folder, "installed"),
    outside = path.join(folder, "external");
  const runner = path.join(folder, "copy.ps1");
  await writeFile(
    runner,
    "param($Helper,$Build,$Runtime)\n$ErrorActionPreference='Stop'\n. $Helper\nCopy-AIROOMRuntime -Source $Build -Destination $Runtime\nexit 0\n",
  );
  try {
    await mkdir(path.join(source, "resources/app/node_modules/npm"), {
      recursive: true,
    });
    await writeFile(
      path.join(source, "resources/app/node_modules/npm/package.json"),
      "{}",
    );
    await mkdir(path.join(target, "resources/app/node_modules/npm"), {
      recursive: true,
    });
    await mkdir(outside);
    await writeFile(path.join(outside, "keep.txt"), "external files unchanged");
    await symlink(
      outside,
      path.join(target, "resources/app/node_modules/npm/docs"),
      "junction",
    );
    const copy = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        runner,
        path.resolve("scripts/copy-runtime.ps1"),
        source,
        target,
      ],
      { encoding: "utf8", timeout: 20_000, windowsHide: true },
    );
    assert.notEqual(copy.status, 0);
    assert.match(copy.stderr, /documentation|links/);
    assert.equal(
      await readFile(path.join(outside, "keep.txt"), "utf8"),
      "external files unchanged",
    );
  } finally {
    assert.equal(path.dirname(folder), root);
    await rm(folder, { recursive: true, force: true });
  }
});
