import "../scripts/test-bootstrap.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  symlink,
  realpath,
  rm,
  access,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { fullProfileCopy } from "../scripts/full-profile-copy";
test("full migration copy includes personal/native files, consistent SQLite and relocated internal Windows cache links", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "AIROOM-full-copy-")),
    data = path.join(root, "data"),
    copy = path.join(root, "retained");
  await mkdir(path.join(data, "native", "cache"), { recursive: true });
  await mkdir(path.join(data, "desks"));
  await writeFile(
    path.join(data, "native", "dummy-login"),
    "synthetic credential bytes",
  );
  await writeFile(path.join(data, "desks", "manuscript"), "personal work");
  await writeFile(path.join(data, "native", "cache", "file"), "cache bytes");
  await symlink(
    path.join(data, "native", "cache"),
    path.join(data, "native", "alias"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const db = new DatabaseSync(path.join(data, "airoom.sqlite"));
  db.exec(
    'CREATE TABLE sentinel(value TEXT);INSERT INTO sentinel VALUES ("saved")'.replace(
      '"saved"',
      "'saved'",
    ),
  );
  db.close();
  try {
    const result = await fullProfileCopy(data, copy);
    assert.equal(result.internalLinks, 1);
    assert.equal(
      await readFile(path.join(copy, "data", "native", "dummy-login"), "utf8"),
      "synthetic credential bytes",
    );
    assert.equal(
      await readFile(path.join(copy, "data", "desks", "manuscript"), "utf8"),
      "personal work",
    );
    assert.equal(
      await realpath(path.join(copy, "data", "native", "alias")),
      await realpath(path.join(copy, "data", "native", "cache")),
    );
    const saved = new DatabaseSync(path.join(copy, "data", "airoom.sqlite"), {
      readOnly: true,
    });
    try {
      assert.equal(
        (saved.prepare("SELECT value FROM sentinel").get() as { value: string })
          .value,
        "saved",
      );
    } finally {
      saved.close();
    }
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 100,
    });
  }
});
test("external profile junctions refuse before writing a partial retained copy", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "AIROOM-full-copy-")),
    data = path.join(root, "data"),
    outside = path.join(root, "outside"),
    copy = path.join(root, "retained");
  await mkdir(data);
  await mkdir(outside);
  await symlink(
    outside,
    path.join(data, "link"),
    process.platform === "win32" ? "junction" : "dir",
  );
  try {
    await assert.rejects(fullProfileCopy(data, copy), /外部目录/);
    await assert.rejects(access(copy));
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 100,
    });
  }
});
