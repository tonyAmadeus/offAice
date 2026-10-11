import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { resolveSafePath } from "./security";
import type { WorkspaceChange } from "./workspace";

type State = { hash: string; mode: number };
interface Writeback {
  version: 1;
  runId: string;
  directory: string;
  status: "applying" | "applied" | "undoing" | "undone";
  at: string;
  files: { path: string; before?: State; after?: State }[];
}
export interface ProjectUndo {
  changes: WorkspaceChange[];
  conflicts: { path: string; reason: string }[];
  canRestoreUnchanged: boolean;
  status: Writeback["status"];
}
const hash = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const absent = (e: unknown) =>
  ["ENOENT", "ENOTDIR"].includes((e as NodeJS.ErrnoException).code ?? "");
const equal = (a?: State, b?: State) =>
  a?.hash === b?.hash && a?.mode === b?.mode;
const places = (root: string) => ({
  file: resolveSafePath(root, ".airoom/writeback.json"),
  objects: resolveSafePath(root, ".airoom/writeback-objects"),
});
async function state(
  root: string,
  name: string,
  objects?: string,
): Promise<State | undefined> {
  const file = resolveSafePath(root, name);
  let stat;
  try {
    stat = await fs.lstat(file);
  } catch (e) {
    if (absent(e)) return;
    throw e;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024 * 1024)
    throw new Error("写回还原点只接受 128 MiB 以内的普通文件。");
  const bytes = await fs.readFile(file),
    after = await fs.lstat(file);
  if (
    stat.size !== after.size ||
    stat.mtimeMs !== after.mtimeMs ||
    stat.ino !== after.ino
  )
    throw new Error("保存写回还原点时文件发生改变。");
  const digest = hash(bytes);
  if (objects) {
    await fs.mkdir(objects, { recursive: true });
    const target = resolveSafePath(objects, digest);
    await fs.writeFile(target, bytes, { flag: "wx" }).catch((e) => {
      if (e.code !== "EEXIST") throw e;
    });
    if (hash(await fs.readFile(target)) !== digest)
      throw new Error("写回还原点校验失败。");
  }
  return { hash: digest, mode: stat.mode & 0o777 };
}
async function save(root: string, record: Writeback) {
  const file = places(root).file,
    tmp = file + "." + randomUUID() + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(record));
  await fs.rename(tmp, file);
}
async function load(root: string, runId: string, directory: string) {
  let record: Writeback;
  try {
    record = JSON.parse(await fs.readFile(places(root).file, "utf8"));
  } catch (e) {
    if (absent(e)) return;
    throw e;
  }
  if (
    record.version !== 1 ||
    path.resolve(record.directory).toLowerCase() !==
      path.resolve(directory).toLowerCase()
  )
    throw new Error("写回还原点与当前项目不匹配。");
  if (record.runId !== runId) {
    if (["applying", "undoing"].includes(record.status))
      throw new Error("上次写回或撤销没有完整结束，请先人工核对。");
    return;
  }
  return record;
}
/** Persist exact original bytes before the first write. The project write queue must be held by the caller. */
export async function beginWriteback(
  root: string,
  directory: string,
  runId: string,
  changes: WorkspaceChange[],
) {
  const previous = await load(root, runId, directory);
  if (previous && ["applying", "undoing"].includes(previous.status))
    throw new Error("上次写回或撤销没有完整结束，请先人工核对。");
  const objects = places(root).objects,
    files: Writeback["files"] = [];
  for (const change of changes) {
    const old =
      previous?.status === "applied"
        ? previous.files.find((f) => f.path === change.path)
        : undefined;
    files.push({
      path: change.path,
      before: old ? old.before : await state(directory, change.path, objects),
      after: await state(root, change.path, objects),
    });
  }
  if (previous?.status === "applied")
    for (const file of previous.files)
      if (!files.some((f) => f.path === file.path)) files.push(file);
  const record: Writeback = {
    version: 1,
    runId,
    directory,
    status: "applying",
    at: new Date().toISOString(),
    files,
  };
  await save(root, record);
  return async () => {
    for (const item of files)
      if (!equal(await state(directory, item.path), item.after))
        throw new Error("写回结束状态校验失败。");
    record.status = "applied";
    await save(root, record);
  };
}
export async function projectUndoInfo(
  root: string,
  runId: string,
  directory: string,
): Promise<ProjectUndo | undefined> {
  const record = await load(root, runId, directory);
  if (!record || record.status === "undone") return;
  const conflicts = [];
  for (const item of record.files) {
    try {
      if (!equal(await state(directory, item.path), item.after))
        conflicts.push({
          path: item.path,
          reason: "写回后原文件又被修改，保留当前内容",
        });
    } catch (e) {
      conflicts.push({ path: item.path, reason: (e as Error).message });
    }
  }
  if (["applying", "undoing"].includes(record.status))
    conflicts.push({
      path: "写回记录",
      reason: "上次写回或撤销没有完整结束，请先人工核对",
    });
  return {
    status: record.status,
    changes: record.files.map((f) => ({
      path: f.path,
      kind: !f.before ? "added" : !f.after ? "deleted" : "modified",
    })),
    conflicts,
    canRestoreUnchanged:
      record.status === "applied" && conflicts.length < record.files.length,
  };
}
async function restore(
  root: string,
  name: string,
  value: State | undefined,
  objects: string,
) {
  const file = resolveSafePath(root, name);
  if (!value) {
    await fs.unlink(file).catch((e) => {
      if (!absent(e)) throw e;
    });
    return;
  }
  if (!/^[a-f0-9]{64}$/.test(value.hash))
    throw new Error("还原点文件编号无效。");
  const bytes = await fs.readFile(resolveSafePath(objects, value.hash));
  if (hash(bytes) !== value.hash) throw new Error("还原点内容校验失败。");
  await fs.mkdir(path.dirname(file), { recursive: true });
  resolveSafePath(root, name);
  const temp = file + ".airoom-undo-" + randomUUID();
  try {
    await fs.writeFile(temp, bytes, { flag: "wx", mode: value.mode });
    await fs.chmod(temp, value.mode);
    resolveSafePath(root, name);
    await fs.rename(temp, file);
  } finally {
    await fs.unlink(temp).catch(() => {});
  }
}
/** Restore unchanged originals and the work copy as one operation; roll originals back if copy undo fails. */
export async function undoWriteback<T extends { status: string }>(
  root: string,
  runId: string,
  directory: string,
  partial: boolean,
  check: (paths: string[]) => void,
  undoCopy: () => Promise<T>,
): Promise<T> {
  const record = await load(root, runId, directory);
  if (!record || record.status === "undone") return undoCopy();
  const info = await projectUndoInfo(root, runId, directory);
  if (!info || record.status !== "applied")
    throw new Error("写回状态尚未确认，未撤销。");
  if (info.conflicts.length && !partial)
    throw new Error("原文件写回后又被修改，请先选择只恢复没变过的文件。");
  const selected = record.files.filter(
      (f) => !info.conflicts.some((c) => c.path === f.path),
    ),
    applied: typeof selected = [];
  if (!selected.length) throw new Error("原文件全部发生后续改动，未撤销。");
  const objects = places(root).objects,
    baselineFile = resolveSafePath(root, ".airoom/baseline.json"),
    baselineBytes = await fs.readFile(baselineFile),
    baseline = JSON.parse(baselineBytes.toString());
  check(selected.map((f) => f.path));
  let copyUndone = false;
  try {
    // Verify every saved blob before changing any original.
    for (const item of selected)
      for (const value of [item.before, item.after])
        if (
          value &&
          (!/^[a-f0-9]{64}$/.test(value.hash) ||
            hash(await fs.readFile(resolveSafePath(objects, value.hash))) !==
              value.hash)
        )
          throw new Error("还原点内容校验失败。");
    record.status = "undoing";
    await save(root, record);
    for (const item of selected) {
      check([item.path]);
      if (!equal(await state(directory, item.path), item.after))
        throw new Error("撤销前原文件又被修改。");
      await restore(directory, item.path, item.before, objects);
      applied.push(item);
    }
    for (const item of selected) {
      if (item.before) baseline.files[item.path] = item.before.hash;
      else delete baseline.files[item.path];
    }
    await fs.writeFile(baselineFile, JSON.stringify(baseline));
    const result = await undoCopy();
    if (result.status !== "undone")
      throw new Error("工作副本状态变化，未完成撤销。");
    copyUndone = true;
    record.status = "undone";
    record.at = new Date().toISOString();
    await save(root, record);
    return result;
  } catch (error) {
    if (copyUndone)
      throw new Error("文件已还原，但撤销记录未能保存，请人工核对后继续。");
    for (const item of applied.reverse()) {
      if (!equal(await state(directory, item.path), item.before))
        throw new Error("撤销期间原文件再次改变，回滚待核对。");
      await restore(directory, item.path, item.after, objects);
    }
    await fs.writeFile(baselineFile, baselineBytes);
    record.status = "applied";
    await save(root, record);
    throw error;
  }
}
