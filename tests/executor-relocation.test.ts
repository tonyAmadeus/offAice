import "../scripts/test-bootstrap.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, cp, rm, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { readProgramIdentity } from "../src/backend/compatibility";
import { ADAPTER_CONTRACT_VERSION } from "../src/shared/compatibility";
import {
  planRelocation,
  applyRelocation,
  preserveBoundExecutor,
} from "../scripts/executor-relocation";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "AIROOM-relocation-")),
    source = path.join(root, "old"),
    destination = path.join(root, "new"),
    pkg = path.join(source, "node_modules", "fixture");
  await mkdir(pkg, { recursive: true });
  await writeFile(
    path.join(pkg, "package.json"),
    JSON.stringify({
      name: "fixture",
      version: "1.0.0",
      dependencies: { dep: "1.0.0" },
    }),
  );
  await writeFile(path.join(pkg, "cli.js"), 'console.log("fixture")');
  const dependency = path.join(source, "node_modules", "dep");
  await mkdir(dependency);
  await writeFile(
    path.join(dependency, "package.json"),
    JSON.stringify({ name: "dep", version: "1.0.0" }),
  );
  await writeFile(path.join(dependency, "index.js"), "dependency");
  await cp(source, destination, { recursive: true });
  const from = path.join(pkg, "cli.js"),
    to = path.join(destination, "node_modules", "fixture", "cli.js");
  const db = new DatabaseSync(path.join(root, "fixture.sqlite"));
  db.exec(
    "CREATE TABLE entities(entity TEXT,id TEXT,value TEXT,PRIMARY KEY(entity,id))",
  );
  const session = {
    id: "session",
    nativeId: "keep-native",
    nativeHome: "keep-home",
    executorIdentity: {
      ...readProgramIdentity(from),
      adapterVersion: ADAPTER_CONTRACT_VERSION,
      protocol: "acp",
    },
  };
  db.prepare("INSERT INTO entities VALUES(?,?,?)").run(
    "sessions",
    session.id,
    JSON.stringify(session),
  );
  db.prepare("INSERT INTO entities VALUES(?,?,?)").run(
    "runs",
    "history",
    JSON.stringify({
      id: "history",
      executorIdentity: session.executorIdentity,
    }),
  );
  return {
    root,
    source,
    from,
    to,
    destination,
    db,
    session,
    close: async () => {
      db.close();
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 100,
      });
    },
  };
}
test("same executor relocation preserves native context and immutable historical run audit", async () => {
  const f = await fixture();
  try {
    const before = f.db
      .prepare("SELECT value FROM entities WHERE entity='runs'")
      .get();
    assert.equal(applyRelocation(f.db, planRelocation(f.db, f.from, f.to)), 1);
    const after = JSON.parse(
      (
        f.db
          .prepare("SELECT value FROM entities WHERE entity='sessions'")
          .get() as { value: string }
      ).value,
    );
    assert.deepEqual(after, {
      ...f.session,
      executorIdentity: { ...f.session.executorIdentity, path: f.to },
    });
    assert.deepEqual(
      f.db.prepare("SELECT value FROM entities WHERE entity='runs'").get(),
      before,
    );
  } finally {
    await f.close();
  }
});
test("different program or dependency versions cannot silently rebind a historical session", async () => {
  const f = await fixture();
  try {
    await writeFile(f.to, "changed");
    assert.throws(() => planRelocation(f.db, f.from, f.to), /identity differs/);
    await cp(f.from, f.to);
    await writeFile(
      path.join(f.destination, "node_modules", "dep", "package.json"),
      JSON.stringify({ name: "dep", version: "2.0.0" }),
    );
    assert.throws(
      () => planRelocation(f.db, f.from, f.to),
      /dependency versions differ/,
    );
  } finally {
    await f.close();
  }
});
test("stale relocation plan refuses the entire transaction without changing resume paths", async () => {
  const f = await fixture();
  try {
    const plan = planRelocation(f.db, f.from, f.to);
    f.db
      .prepare("UPDATE entities SET value=? WHERE entity='sessions'")
      .run(JSON.stringify({ ...f.session, title: "changed" }));
    assert.throws(() => applyRelocation(f.db, plan), /stale/);
    assert.equal(
      JSON.parse(
        (
          f.db
            .prepare("SELECT value FROM entities WHERE entity='sessions'")
            .get() as { value: string }
        ).value,
      ).executorIdentity.path,
      f.from,
    );
  } finally {
    await f.close();
  }
});
test("preserved historical executor includes exact transitive package layout and verifies for relocation", async () => {
  const f = await fixture();
  try {
    const destination = path.join(f.root, "preserved"),
      result = await preserveBoundExecutor(f.from, f.source, destination);
    assert.equal(result.packages, 2);
    assert.equal(
      await readFile(
        path.join(destination, "node_modules", "dep", "index.js"),
        "utf8",
      ),
      "dependency",
    );
    assert.equal(planRelocation(f.db, f.from, result.entry).sessions.length, 1);
  } finally {
    await f.close();
  }
});
