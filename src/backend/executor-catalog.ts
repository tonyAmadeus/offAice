import path from "node:path";
import type {
  AcpExecutor,
  ProviderId,
  Settings,
} from "../shared/types";
import { ACP_DEFAULT_PERMISSIONS, isAcpId } from "../shared/defaults";
import {
  CATALOG_REVISION,
  EXECUTOR_CATALOG,
  ALL_EXECUTOR_CATALOG,
  catalogEntry,
  catalogProvider,
  type CatalogId,
  type CatalogStatus,
} from "../shared/executor-catalog";
import { installedVersions } from "./member-versions";
import type { Store } from "./store";
import { zcodeRepairVersion } from "./zcode-install";
import {cursorNodeEnvironment} from "./cursor-install";

export function catalogStatuses(
  store: Store,
  settings: Settings,
): CatalogStatus[] {
  return EXECUTOR_CATALOG.map((entry) => {
    const provider = catalogProvider(entry.id),
      executor = isAcpId(provider)
        ? store.get<AcpExecutor>("executors", provider)
        : undefined;
    const selected = executor?.command ?? settings.paths[provider],
      installed = installedVersions(store.dataDirectory, entry.id);
    const selectedVersion = selected
      ? installed.find(
          (item) =>
            path.resolve(item.entry).toLowerCase() ===
            path.resolve(selected).toLowerCase(),
        )?.version
      : undefined;
    const repair =
      entry.id === "zcode" && !selectedVersion
        ? zcodeRepairVersion(store.dataDirectory, selected)
        : undefined;
    return {
      entry,
      provider,
      installed: installed.map((item) => item.version),
      selectedPath: selected,
      selectedVersion: selectedVersion ?? repair,
      needsRepair: !!repair,
      configured: !!selected,
      consented:
        store.get<{ revision: string }>("catalog_consents", entry.id)
          ?.revision === CATALOG_REVISION,
    };
  });
}
export function catalogCandidate(
  id: CatalogId,
  command: string,
  existing?: AcpExecutor,
): AcpExecutor {
  const entry = catalogEntry(id),
    provider = catalogProvider(id);
  if (!isAcpId(provider)) throw new Error("内置成员使用原生连接。");
  if (existing && existing.catalogId !== id)
    throw new Error("清单连接编号已被其他配置使用，未覆盖原配置。");
  return {
    ...existing,
    id: provider,
    name: existing?.name ?? entry.name,
    command,
    args: [...entry.args],
    env: existing?.env ?? {},
    permissions: existing?.permissions ?? ACP_DEFAULT_PERMISSIONS,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    catalogId: id,
    authentication: existing?.authentication ?? (existing && id === 'zcode' ? 'zai' : entry.authentication[0].id),
  };
}
/** Managed programs never read a user's global login folders or inherit another program's API key. */
export function managedCatalogEnvironment(
  executor: AcpExecutor,
  base: NodeJS.ProcessEnv,
  home: string,
): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const key of Object.keys(env))
    if (
      /^(?:GEMINI|GOOGLE|QWEN|QODER|QODERCN|CURSOR|KIMI|OPENCODE|OPENAI|XAI|MINIMAX|ZCODE|ZAI|ZHIPU|BIGMODEL)_/i.test(
        key,
      )
    )
      delete env[key];
  for (const entry of ALL_EXECUTOR_CATALOG)
    for (const auth of entry.authentication)
      for (const key of auth.secretKeys ?? []) delete env[key];
  Object.assign(env, executor.env, {
    AIROOM_NODE_CHILD_MODE: "1",
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_DATA_HOME: path.join(home, "data"),
    XDG_STATE_HOME: path.join(home, "state"),
    XDG_CACHE_HOME: path.join(home, "cache"),
    NODE_COMPILE_CACHE: path.join(home, "cache", "node"),
  });
  const entry = executor.catalogId
    ? catalogEntry(executor.catalogId)
    : undefined;
  for (const [key, directory] of Object.entries(
    entry?.profileDirectories ?? {},
  ))
    env[key] = path.join(home, directory);
  if (entry?.providerConfigEnvironment) {
    const auth = entry.authentication.find(
      (item) => item.id === executor.authentication,
    );
    if (auth?.kind === "api")
      env[entry.providerConfigEnvironment] = JSON.stringify({
        enabled_providers: [auth.id],
        provider: {
          [auth.id]: { options: { apiKey: `{env:${auth.secretKeys![0]}}` } },
        },
      });
  }
  if(entry?.id==='cursor')return cursorNodeEnvironment(executor.command,{...env,NODE_COMPILE_CACHE:path.join(home,'cache','node')});
  return env;
}
export function catalogAuthentication(executor: AcpExecutor, params: any) {
  const entry = catalogEntry(executor.catalogId),
    auth = entry.authentication.find(
      (item) => item.id === params.authentication,
    );
  if (!auth) throw new Error("请选择清单中支持的登录方式。");
  const env = { ...executor.env },
    secrets: Record<string, string> = {};
  for (const method of entry.authentication) {
    for (const key of method.secretKeys ?? []) delete env[key];
    for (const key of Object.keys(method.environment ?? {})) delete env[key];
  }
  for (const item of ALL_EXECUTOR_CATALOG)
    for (const key of [
      item.modelConfiguration?.environment,
      item.modelConfiguration?.baseUrlEnvironment,
    ])
      if (key) delete env[key];
  Object.assign(env, auth.environment ?? {});
  for (const [key, value] of Object.entries(params.secrets ?? {})) {
    if (
      !auth.secretKeys?.includes(key) ||
      typeof value !== "string" ||
      value.length > 4096
    )
      throw new Error("密钥变量不属于所选登录方式。");
    if (value.trim()) secrets[key] = value.trim();
  }
  const model = String(params.model ?? "")
    .trim()
    .slice(0, 120);
  if (
    entry.modelConfiguration?.providerPrefix &&
    model &&
    !model.startsWith(auth.id + "/")
  )
    throw new Error(
      "所选模型必须属于当前登录方式，格式为“" + auth.id + "/模型”。",
    );
  if (
    auth.kind === "api" &&
    Object.keys(secrets).length &&
    auth.modelRequired &&
    !model
  )
    throw new Error("请填写这个 API 账号可用的模型。");
  const config = entry.modelConfiguration;
  if (
    config?.baseUrlRequired &&
    Object.keys(secrets).length &&
    !String(params.baseUrl ?? "").trim()
  )
    throw new Error("请填写该 API 账号对应的服务地址。");
  if (config?.environment && model) env[config.environment] = model;
  if (config?.baseUrlEnvironment && params.baseUrl) {
    const url = new URL(String(params.baseUrl));
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("API 服务地址无效。");
    env[config.baseUrlEnvironment] = url.toString().replace(/\/$/, "");
  }
  return {
    executor: {
      ...executor,
      authentication: auth.id,
      env,
      model: config?.persistSelection ? model || undefined : undefined,
      secretKeys: Object.keys(secrets).sort(),
    },
    secrets,
  };
}
export function assertCatalogVersionUnused(
  store: Store,
  settings: Settings,
  id: CatalogId,
  version: string,
) {
  const root = path.resolve(store.dataDirectory, "members", id, version);
  const inside = (file: string | undefined) => {
    if (!file) return false;
    const rel = path.relative(root, path.resolve(file));
    return (
      !rel ||
      (!rel.startsWith(".." + path.sep) &&
        rel !== ".." &&
        !path.isAbsolute(rel))
    );
  };
  if (
    Object.values(settings.paths).some(inside) ||
    store.executors().some((item) => inside(item.command))
  )
    throw new Error("这个版本仍被执行端或人物卡选用，请先切换到其他版本。");
}
