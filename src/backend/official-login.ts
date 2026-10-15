import type { ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import {
  ALL_EXECUTOR_CATALOG,
  type CatalogLoginState,
} from "../shared/executor-catalog";
import { spawnCli, type CliCommand } from "./adapters/common";
import { waitForNpmOutput } from "./member-versions";
import {
  defaultBrowserLoginCommand,
  defaultBrowserLoginEnvironment,
} from "./login-browser";

export function officialExecutorLoginUrl(
  provider: string,
  value: string,
): string | undefined {
  const domains = ALL_EXECUTOR_CATALOG.find((entry) => entry.id === provider)
    ?.login?.domains;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port)
      return;
    if (
      domains?.some(
        (domain) =>
          url.hostname === domain || url.hostname.endsWith("." + domain),
      )
    )
      return url.href;
  } catch {
    /* Untrusted CLI text is never a browser command. */
  }
}
/** Only official HTTPS links and device codes leave the parser; never raw logs or tokens. */
export function officialExecutorLoginOutput(
  provider: string,
  progress: (state: CatalogLoginState) => void,
) {
  const decoder = new StringDecoder("utf8");
  let buffer = "",
    url: string | undefined,
    code: string | undefined;
  const parse = (final = false) => {
    buffer = buffer.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
    for (const match of buffer.matchAll(/https:\/\/[^\s<>"'\x1b]+/g)) {
      if (!final && match.index! + match[0].length === buffer.length) continue;
      url =
        officialExecutorLoginUrl(provider, match[0].replace(/[),.;]+$/, "")) ??
        url;
    }
    code =
      buffer.match(
        /(?:enter code|user.code|verification code|验证码)\s*[:：]\s*([A-Z0-9][A-Z0-9-]{3,20})/i,
      )?.[1] ?? code;
    if (url)
      progress({
        phase: "waiting",
        message: "请在官方网页完成授权，AIROOM 会在完成后自动检查连接。",
        url,
        ...(code ? { code } : {}),
      });
    buffer = buffer.slice(-32768);
  };
  return {
    write(chunk: Buffer) {
      buffer += decoder.write(chunk);
      parse();
    },
    end() {
      buffer += decoder.end();
      parse(true);
      buffer = "";
    },
  };
}
/** Shown when an official login page is slow to appear; the attempt continues. */
export const SLOW_LOGIN_PAGE: CatalogLoginState = {
  phase: "waiting",
  message: "官方登录页面还在准备，首次启动会慢一些。浏览器打开授权页后请完成授权；长时间没有打开可以取消后重试。",
};
export async function runOfficialExecutorLogin(
  provider: string,
  command: CliCommand,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  register: (child: ChildProcess) => void,
  progress?: (state: CatalogLoginState) => void,
) {
  progress?.({ phase: "starting", message: "正在启动官方授权流程…" });
  command = defaultBrowserLoginCommand(command);
  env = defaultBrowserLoginEnvironment(env);
  if (
    ALL_EXECUTOR_CATALOG.find((entry) => entry.id === provider)?.login
      ?.noBrowser &&
    !args.includes("--no-browser")
  )
    args = [...args, "--no-browser"];
  const child = spawnCli(command, args, { cwd, env });
  register(child);
  // A first start can outlast this hint; the program keeps running until the login deadline.
  const preparationTimer=setTimeout(()=>progress?.(SLOW_LOGIN_PAGE),30_000);
  for (const stream of [child.stdout, child.stderr]) {
    const parser = officialExecutorLoginOutput(provider, (state) => {if(state.phase==='waiting')clearTimeout(preparationTimer);progress?.(state);});
    stream?.on("data", (chunk: Buffer) => parser.write(chunk));
    stream?.on("end", () => parser.end());
  }
  // Uses the same owned-process timeout/drain guarantees as managed downloads.
  try{
    const result = await waitForNpmOutput(child, 5 * 60_000);
    if(result.code!==0)throw new Error('官方登录没有完成，请重试登录或检查网络。');
  }finally{clearTimeout(preparationTimer);}
}
