import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import {
  readFileSync,
  readdirSync,
  lstatSync,
  realpathSync,
  existsSync,
} from "node:fs";
import { cp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { readProgramIdentity } from "../src/backend/compatibility";
import { ADAPTER_CONTRACT_VERSION } from "../src/shared/compatibility";
import type { Session } from "../src/shared/types";

const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const samePath = (a: string, b: string) =>
  path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
function packageRoot(entry: string) {
  let root = path.dirname(entry);
  while (!existsSync(path.join(root, "package.json"))) {
    const next = path.dirname(root);
    if (next === root) throw Error("Missing package manifest");
    root = next;
  }
  return root;
}
function tree(root: string): string {
  const entries: string[] = [];
  function visit(folder: string) {
    for (const name of readdirSync(folder).sort()) {
      if (name === "node_modules") continue;
      const file = path.join(folder, name),
        info = lstatSync(file);
      if (info.isSymbolicLink()) throw Error("Package contains a link");
      if (info.isDirectory()) visit(file);
      else if (info.isFile())
        entries.push(
          path.relative(root, file) + ":" + hash(readFileSync(file)),
        );
    }
  }
  visit(root);
  return hash(entries.join("\n"));
}
function dependencyVersions(
  root: string,
  seen = new Map<string, string>(),
): Map<string, string> {
  const manifest = JSON.parse(
    readFileSync(path.join(root, "package.json"), "utf8"),
  );
  for (const [name] of Object.entries(manifest.dependencies ?? {})) {
    let directory = root,
      target: string | undefined;
    while (true) {
      const candidate = path.join(
        directory,
        "node_modules",
        name,
        "package.json",
      );
      if (existsSync(candidate)) {
        target = path.dirname(candidate);
        break;
      }
      const next = path.dirname(directory);
      if (next === directory) break;
      directory = next;
    }
    if (!target) throw Error("Required dependency missing: " + name);
    const value = JSON.parse(
      readFileSync(path.join(target, "package.json"), "utf8"),
    );
    const key = name + "@" + value.version;
    if (seen.has(key)) continue;
    seen.set(key, hash(readFileSync(path.join(target, "package.json"))));
    dependencyVersions(target, seen);
  }
  return seen;
}
/** Preserve exact relative package locations, including optional/native peers.
 * This is a historical resume environment, never the current download choice. */
export async function preserveBoundExecutor(
  entry: string,
  sourceRoot: string,
  destination: string,
) {
  const packages = new Set<string>();
  function collect(root: string) {
    root = realpathSync(root);
    if (packages.has(root)) return;
    if (!root.startsWith(path.resolve(sourceRoot) + path.sep))
      throw Error("Dependency outside source runtime");
    packages.add(root);
    const manifest = JSON.parse(
      readFileSync(path.join(root, "package.json"), "utf8"),
    );
    for (const name of new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ])) {
      let directory = root,
        target: string | undefined;
      while (true) {
        const candidate = path.join(
          directory,
          "node_modules",
          name,
          "package.json",
        );
        if (existsSync(candidate)) {
          target = path.dirname(candidate);
          break;
        }
        const next = path.dirname(directory);
        if (next === directory) break;
        directory = next;
      }
      if (target) collect(target);
      else if (
        name in (manifest.dependencies ?? {}) &&
        !(name in (manifest.optionalDependencies ?? {}))
      )
        throw Error("Required dependency missing: " + name);
    }
  }
  collect(packageRoot(entry));
  await mkdir(destination, { recursive: true });
  for (const source of packages) {
    const target = path.resolve(destination, path.relative(sourceRoot, source));
    if (!target.startsWith(path.resolve(destination) + path.sep))
      throw Error("Invalid copy path");
    const expected = tree(source);
    if (existsSync(target) && tree(target) === expected) continue;
    await cp(source, target, {
      recursive: true,
      filter: async (file) => {
        if (lstatSync(file).isSymbolicLink())
          throw Error("Package contains a link");
        return (
          path.relative(source, file).split(path.sep)[0] !== "node_modules"
        );
      },
    });
    if (expected !== tree(target))
      throw Error("Preserved package bytes differ");
  }
  const target = path.join(destination, path.relative(sourceRoot, entry));
  verifyPair(entry, target);
  await writeFile(
    path.join(destination, "preserved-executor.json"),
    JSON.stringify(
      {
        entry: path.relative(destination, target),
        version: readProgramIdentity(target).version,
        packages: packages.size,
        reason:
          "Exact historical DSH dependency graph for native session resume. Not an AIROOM installation.",
      },
      null,
      2,
    ),
  );
  return { entry: target, packages: packages.size };
}
function verifyPair(from: string, to: string) {
  const before = readProgramIdentity(from),
    after = readProgramIdentity(to);
  if (
    !before.version ||
    before.version !== after.version ||
    before.digest !== after.digest
  )
    throw Error("Executor identity differs; relocation refused");
  if (tree(packageRoot(from)) !== tree(packageRoot(to)))
    throw Error("Executor package content differs; relocation refused");
  const dependencies = (file: string) =>
    JSON.stringify(
      [...dependencyVersions(packageRoot(file))].sort(([a], [b]) =>
        a.localeCompare(b),
      ),
    );
  if (dependencies(from) !== dependencies(to))
    throw Error("Executor dependency versions differ; relocation refused");
  return { before, after };
}
export interface RelocationPlan {
  from: string;
  to: string;
  digest: string;
  version: string;
  sessions: { id: string; fingerprint: string }[];
}
export function planRelocation(
  db: DatabaseSync,
  from: string,
  to: string,
): RelocationPlan {
  from = realpathSync(from);
  to = realpathSync(to);
  if (samePath(from, to)) throw Error("Paths must differ");
  const { before, after } = verifyPair(from, to);
  const sessions = (
    db
      .prepare("SELECT id,value FROM entities WHERE entity='sessions'")
      .all() as { id: string; value: string }[]
  ).filter((row) =>
    samePath(
      (JSON.parse(row.value) as Session).executorIdentity?.path ?? "",
      from,
    ),
  );
  for (const row of sessions) {
    const identity = (JSON.parse(row.value) as Session).executorIdentity!;
    if (
      identity.digest !== before.digest ||
      identity.adapterVersion !== ADAPTER_CONTRACT_VERSION ||
      (identity.version && identity.version !== before.version)
    )
      throw Error("Historical session identity differs: " + row.id);
  }
  return {
    from,
    to,
    digest: after.digest!,
    version: after.version!,
    sessions: sessions.map((row) => ({
      id: row.id,
      fingerprint: hash(row.value),
    })),
  };
}
/** Only the resume path changes. Native IDs/homes and immutable run audit records remain byte-for-byte intact. */
export function applyRelocation(db: DatabaseSync, plan: RelocationPlan) {
  const current = planRelocation(db, plan.from, plan.to);
  if (JSON.stringify(current) !== JSON.stringify(plan))
    throw Error("Relocation plan is stale");
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of plan.sessions) {
      const stored = db
        .prepare("SELECT value FROM entities WHERE entity='sessions' AND id=?")
        .get(row.id) as { value: string };
      if (hash(stored.value) !== row.fingerprint)
        throw Error("Session changed");
      const session = JSON.parse(stored.value) as Session;
      session.executorIdentity = {
        ...session.executorIdentity!,
        path: plan.to,
      };
      db.prepare(
        "UPDATE entities SET value=? WHERE entity='sessions' AND id=?",
      ).run(JSON.stringify(session), row.id);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return plan.sessions.length;
}
