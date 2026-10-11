import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { AcpExecutor } from "../../shared/types";
import { catalogEntry } from "../../shared/executor-catalog";
/** Qoder's official client auto-updates itself; pin managed installs to the verified inventory. */
export async function prepareManagedConfig(
  executor: AcpExecutor,
  env: NodeJS.ProcessEnv,
) {
  const policy = executor.catalogId
    ? catalogEntry(executor.catalogId).managedConfig
    : undefined;
  if (!policy) return;
  const folder = env[policy.directoryEnvironment]!;
  await mkdir(folder, { recursive: true });
  const file = path.join(folder, policy.file);
  let settings: any = {};
  try {
    settings = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new Error("Qoder 配置无法读取，请核对独立目录。");
  }
  if (!settings || typeof settings !== "object" || Array.isArray(settings))
    throw new Error("Qoder 配置无效。");
  if (settings.general?.enableAutoUpdate !== false)
    await writeFile(
      file,
      JSON.stringify({
        ...settings,
        general: { ...settings.general, enableAutoUpdate: false },
      }),
    );
}
