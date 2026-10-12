import "../scripts/test-bootstrap.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { JsonLineRpc } from "../src/backend/adapters/common";
import { Engine } from "./helpers/seeded-engine";
import { RoomRuntimePool } from "../src/backend/runtime-pool";
import type { Adapter } from "../src/shared/types";

function deadline<T>(task: Promise<T>, ms = 300): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    task,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Error("fixture deadline exceeded")), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
const adapter = (): Adapter => ({
  start: async () => ({}),
  probe: async () => ({}) as any,
  stop: async () => {},
  dispose: async () => {},
  canReuse: () => true,
});

test("a stuck retired runtime cannot block a new acquisition or leave a reserved slot", async () => {
  const pool = new RoomRuntimePool({ closeTimeoutMs: 20 }),
    old = adapter();
  let release!: () => void;
  old.dispose = () =>
    new Promise<void>((resolve) => {
      release = resolve;
    });
  const first = await pool.acquire("room", "before", () => old);
  await first.release(true);
  const changing = pool.acquire("room", "after", adapter);
  try {
    await assert.rejects(deadline(changing), /回收.*超时/);
    assert.equal(pool.size, 0);
    const healthy = await pool.acquire("peer", "ready", adapter);
    await healthy.release(false);
  } finally {
    release?.();
    await changing.catch(() => {});
    await pool.closeAll();
  }
});

test("idle invalidation and shutdown have a bound even when native disposal never completes", async () => {
  const pool = new RoomRuntimePool({ closeTimeoutMs: 20 }),
    old = adapter();
  let release!: () => void;
  old.dispose = () =>
    new Promise<void>((resolve) => {
      release = resolve;
    });
  const first = await pool.acquire("room", "same", () => old);
  await first.release(true);
  const closing = pool.invalidate();
  try {
    await assert.rejects(deadline(closing), /回收.*超时/);
    assert.equal(pool.size, 0);
    await deadline(pool.closeAll());
  } finally {
    release?.();
    await closing.catch(() => {});
    await pool.closeAll();
  }
});

function transport() {
  const child = Object.assign(new EventEmitter(), {
    exitCode: null,
    signalCode: null,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => true,
  }) as unknown as ChildProcess;
  return {
    child,
    rpc: new JsonLineRpc(child),
    feed: (value: unknown) =>
      (child.stdout as PassThrough).write(JSON.stringify(value) + "\n"),
  };
}

test("response handler exceptions reject the current and other requests without escaping stdout", async () => {
  const { rpc, feed } = transport();
  rpc.onResponse = () => {
    throw Error("invalid native response");
  };
  const first = rpc.request("initialize", {}, 1000),
    second = rpc.request("session/new", {}, 1000);
  const checked = Promise.all([
    assert.rejects(deadline(first), /invalid native response/),
    assert.rejects(deadline(second), /invalid native response/),
  ]);
  try {
    assert.doesNotThrow(() => feed({ id: 1, result: {} }));
    await checked;
    assert.equal(rpc.isOpen, false);
  } finally {
    rpc.close();
    await checked.catch(() => {});
  }
});

test("notification and incoming request handler failures close only their connection", async () => {
  for (const incoming of [false, true]) {
    const { rpc, feed } = transport();
    const broken = () => {
      throw Error("invalid native notification");
    };
    if (incoming) rpc.onIncoming = broken;
    else rpc.onNotification = broken;
    const pending = rpc.request("session/prompt", {}, 1000),
      checked = assert.rejects(
        deadline(pending),
        /invalid native notification/,
      );
    try {
      assert.doesNotThrow(() => feed({ method: "session/update", params: {} }));
      await checked;
      assert.equal(rpc.isOpen, false);
    } finally {
      rpc.close();
      await checked.catch(() => {});
    }
  }
});

test("settings save leaves persisted configuration intact when native cleanup fails", async () => {
  const root = path.resolve(".test-cache/settings-recovery");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, "run-"));
  const engine = new Engine(
    directory,
    () => {},
    () => {},
    adapter,
    { maintenanceOnly: true },
  );
  let release!: () => void;
  try {
    const pool = (engine as any).roomRuntimes as RoomRuntimePool;
    (pool as any).options.closeTimeoutMs = 20;
    const before = structuredClone(engine.settings),
      old = adapter();
    old.dispose = () => new Promise<void>((resolve) => (release = resolve));
    const session = await (engine as any).loungeSession(
      engine.store.members().find((member) => member.id === "codex"),
    );
    const lease = await pool.acquire(session.id, "old", () => old);
    await lease.release(true);
    await assert.rejects(
      engine.invoke("settings.save", { models: { codex: "different" } }),
      /回收.*超时/,
    );
    assert.deepEqual(engine.settings, before);
    assert.deepEqual(engine.store.get("settings", "main"), before);
  } finally {
    release?.();
    await engine.close();
    assert.equal(path.dirname(directory), root);
    await rm(directory, { recursive: true, force: true });
  }
});

test("a save waiting on native cleanup cannot overwrite a newer successful settings save", async () => {
  const root = path.resolve(".test-cache/settings-recovery");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, "run-"));
  const engine = new Engine(
    directory,
    () => {},
    () => {},
    adapter,
    { maintenanceOnly: true },
  );
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>((resolve) => (entered = resolve));
  try {
    const pool = (engine as any).roomRuntimes as RoomRuntimePool,
      old = adapter(),
      before = engine.settings.models.codex;
    old.dispose = () =>
      new Promise<void>((resolve) => {
        release = resolve;
        entered();
      });
    const session = await (engine as any).loungeSession(
      engine.store.members().find((member) => member.id === "codex"),
    );
    const lease = await pool.acquire(session.id, "old", () => old);
    await lease.release(true);
    const saving = engine.invoke("settings.save", {
        models: { codex: "different" },
      }),
      rejected = assert.rejects(saving, /配置发生变化/);
    await ready;
    await engine.invoke("settings.save", { maxParallel: 2 });
    release();
    await rejected;
    assert.equal(engine.settings.models.codex, before);
    assert.equal(engine.settings.maxParallel, 2);
    assert.deepEqual(engine.store.get("settings", "main"), engine.settings);
  } finally {
    release?.();
    await engine.close();
    assert.equal(path.dirname(directory), root);
    await rm(directory, { recursive: true, force: true });
  }
});
