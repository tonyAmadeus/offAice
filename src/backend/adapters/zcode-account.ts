import {readFileSync} from 'node:fs';
import path from 'node:path';
import {zcodeCredentialCipher} from '../zcode-login';

export type ZcodeAccount = 'bigmodel' | 'zai';
export const zcodeAccountName = (account: ZcodeAccount) => account === 'bigmodel' ? 'BigModel 中国区' : 'Z.ai 海外';
export function zcodeAccount(method: string | undefined): ZcodeAccount {
  if (method === undefined || method === 'zai') return 'zai'; // Existing connections retain their original region.
  if (method === 'bigmodel') return method;
  throw new Error('请选择 BigModel 中国区或 Z.ai 海外官方登录。');
}
function json(file: string): any { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return undefined; } }

/** Decrypt locally to verify exact account/key matches; never return or log credentials. */
export function zcodeAccountState(home: string, command: string, account: ZcodeAccount, env?:NodeJS.ProcessEnv) {
  const directory = path.join(home, '.zcode', 'v2');
  const credentials = json(path.join(directory, 'credentials.json'));
  const cipher=zcodeCredentialCipher(home,env);
  const read = (key: string) => {try{return typeof credentials?.[key]==='string'?cipher.decrypt(credentials[key]).trim():'';}catch{return '';}};
  const present = (key: string) => !!read(key);
  const loggedIn = present(`oauth:${account}:access_token`) && present('zcodejwttoken');
  const selection = json(path.join(directory, 'provider_config.json'))?.config?.defaultModelSelection;
  const rules = json(path.join(path.dirname(command), 'provider', 'zcode-builtin.json'))?.config?.providerConfigRules?.providerRules;
  const rule = Array.isArray(rules) ? rules.find(item => item.providerId === selection?.providerId) : undefined;
  const access = rule?.config?.access;
  const selectedAccount: ZcodeAccount | undefined = access?.type === 'zhipu-account' && ['bigmodel', 'zai'].includes(access.accountType) ? access.accountType : undefined;
  const model = typeof selection?.modelId === 'string' ? selection.modelId.trim() : '';
  const provider = typeof selection?.providerId === 'string' ? selection.providerId : '';
  const identity=read(`account-provider:${provider}:identity`);
  const entitled = provider && identity && present(`account-provider:coding-plan:${provider}:account:${encodeURIComponent(identity)}:api-key`);
  // Native CLI login supports individual Coding Plan providers, not API billing or desktop-only plans.
  const supportedChannel = access?.mode === 'individual-coding-plan' && Array.isArray(rule?.config?.builtinModelIds) && rule.config.builtinModelIds.includes(model);
  const ready = Boolean(loggedIn && entitled && selectedAccount === account && supportedChannel && model);
  const name = zcodeAccountName(account);
  const detail = !loggedIn ? `ZCode 尚未完成 ${name} 官方登录，请选择对应地区并授权。`
    : selectedAccount && selectedAccount !== account ? `ZCode 当前模型通道是 ${zcodeAccountName(selectedAccount)}，与所选 ${name} 登录不一致。请重新完成所选地区的官方登录。`
    : !ready ? `ZCode 已有 ${name} 登录记录，但套餐凭据或模型通道尚未配置完整，请重新完成官方登录。`
    : `ZCode CLI 已连接 ${name} 官方编程套餐通道，当前模型 ${model}。账号有效性和可用额度以实际调用为准；检查没有发送模型任务。`;
  return {ready, loggedIn, model, provider, selectedAccount, detail};
}

/** Only structured error codes leave stderr; HTTP headers, cookies and request bodies do not. */
export function zcodeFailure(stderr: string, account: ZcodeAccount) {
  const match = stderr.match(/ProviderBusinessError:\s*\[(\d+)\]|\bproviderCode\s*:\s*['"](\d+)['"]|["']code["']\s*:\s*["'](1113|1302|1305|1308|1309|1310)["']/);
  const code = match?.[1] ?? match?.[2] ?? match?.[3];
  const httpStatus = /\bresponseStatus\s*:\s*429\b|\bHTTP\s+429\b/.test(stderr) ? 429 : undefined;
  let message: string | undefined;
  if (code === '1113') message = `ZCode ${zcodeAccountName(account)} 套餐不可用（1113：余额不足或没有可用资源包）。请核对登录地区、账号套餐和额度；已有订阅时先确认套餐通道，不要仅凭此错误充值。`;
  else if (code === '1302' || httpStatus === 429) message = 'ZCode 官方服务限制了本次请求（' + (code ?? 'HTTP 429') + '），请核对套餐额度或请求频率后再继续。';
  else if (code) message = `ZCode 官方服务拒绝本次请求（错误码 ${code}），请核对官方账号和服务状态。`;
  return {code, httpStatus, message};
}
