import {
  cp,
  lstat,
  readlink,
  readdir,
  mkdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

/** Preserve Windows' internal cache junctions without following them or
 * inspecting credentials. External links refuse the copy before it starts. */
export async function fullProfileCopy(data: string, destination: string) {
  data = path.resolve(data);
  destination = path.resolve(destination);
  if (
    destination.toLowerCase().startsWith(data.toLowerCase() + path.sep) ||
    data === destination
  )
    throw Error("Copy must be outside active data");
  const links: { relative: string; target: string; relativeTarget: string }[] =
    [];
  const inside = (target: string) => {
    const rel = path.relative(data, target);
    return (
      rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel)
    );
  };
  async function inspect(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const source = path.join(directory, entry.name),
        info = await lstat(source);
      if (info.isSymbolicLink()) {
        const target = await readlink(source),
          resolved = path.resolve(path.dirname(source), target);
        if (!inside(resolved))
          throw Error("资料包含指向外部目录的链接，完整副本已停止。");
        links.push({
          relative: path.relative(data, source),
          target,
          relativeTarget: path.relative(data, resolved),
        });
      } else if (info.isDirectory()) await inspect(source);
    }
  }
  await inspect(data);
  await mkdir(destination, { recursive: true });
  const copied = path.join(destination, "data");
  await cp(data, copied, {
    recursive: true,
    errorOnExist: true,
    force: false,
    filter: async (source) =>
      !(await lstat(source)).isSymbolicLink() &&
      !["airoom.sqlite", "airoom.sqlite-wal", "airoom.sqlite-shm"].includes(
        path.basename(source),
      ),
  });
  for (const link of links) {
    const target = path.resolve(copied, link.relativeTarget),
      file = path.resolve(copied, link.relative);
    if (
      !target.toLowerCase().startsWith(copied.toLowerCase() + path.sep) &&
      target !== copied
    )
      throw Error("Unsafe copied link target");
    await mkdir(path.dirname(file), { recursive: true });
    await symlink(
      target,
      file,
      process.platform === "win32" ? "junction" : undefined,
    );
  }
  const db = new DatabaseSync(path.join(data, "airoom.sqlite"), {
    readOnly: true,
  });
  try {
    db.prepare("VACUUM INTO ?").run(path.join(copied, "airoom.sqlite"));
  } finally {
    db.close();
  }
  await writeFile(
    path.join(destination, "profile-links.json"),
    JSON.stringify(
      {
        links,
        note: "Internal links point inside this retained copy; original metadata retained for recovery. No external directories followed.",
      },
      null,
      2,
    ),
  );
  return { directory: destination, internalLinks: links.length };
}
