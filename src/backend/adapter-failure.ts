import type { AdapterResult,Run } from '../shared/types';
export type FailureKind = NonNullable<AdapterResult['failure']>['kind'];
export function failureKind(message: string, code?: unknown): 'failed' | 'rate_limited' {
  return /rate.?limit|429|限流|额度|quota.?exceeded|UsageLimitExceeded|usage.?limit/i.test(message + ' ' + String(code ?? '')) ? 'rate_limited' : 'failed';
}
/** Display text only: original provider messages/codes remain in the run and native activity records. */
export const isConnectionFailure=(message:string)=>!/401|403|unauthorized|reauthentication|not.?authenticated|not.?logged.?in|login.?required|credential.*(?:expired|revoked)/i.test(message)&&/workspace routing discovery (?:failed|timed?\s*out)|ECONN|ENOTFOUND|fetch failed|network|proxy|socket|disconnected|broken pipe|EPIPE/i.test(message);
export function failureMessage(message: string, kind?: FailureKind,delivery?:Run['delivery']): string {
  if (/\b1113\b/.test(message) && /balance|resource|余额|套餐不可用|providerCode|["']code["']/i.test(message)) return /[\u4e00-\u9fff]/.test(message) ? message : '服务端未识别到可用的套餐或余额（1113）。请核对账号、登录地区、套餐通道和额度；已有订阅时先确认授权通道。';
  if (/rate.?limit|429|quota.?exceeded|UsageLimitExceeded|usage.?limit/i.test(message) || kind==='rate_limited') return '成员的额度或请求频率受到限制，已暂停。请在“用量与额度”里查看恢复时间，恢复后再继续。';
  if(/\b403\b|permission_error|Request not allowed/i.test(message))return '服务端拒绝了本次请求（403）。请核对账号权限与当前网络；这不一定是登录过期。原始报错保留在活动记录中。';
  if(isConnectionFailure(message)&&/workspace routing discovery (?:failed|timed?\s*out)/i.test(message))return '订阅账号的工作区连接初始化'+(/timed?\s*out|timeout/i.test(message)?'超时。':'未完成。')+(delivery==='prepared'?'本条消息尚未发出，可以重试；':'请先核对本轮投递记录；')+'请检测成员连接并检查网络。';
  if(isConnectionFailure(message)&&delivery==='prepared')return '成员连接暂时未能建立，这条消息没有发给成员，可以直接重试。';
  if (/[\u4e00-\u9fff]/.test(message)) return message;
  if (/401|unauthorized|reauthentication|not.?authenticated|not.?logged.?in|login.?required|credential.*(?:expired|revoked)/i.test(message)) return '成员的登录已失效，请在成员设置里重新登录，然后检测连接。';
  if (/timed?\s*out|timeout|deadline/i.test(message)) return '等待成员回复的时间过长，已暂停。请先查看活动记录，核对本轮是否完成。';
  if (/ECONN|ENOTFOUND|fetch failed|network|proxy|socket|disconnected|broken pipe|EPIPE/i.test(message)) return '成员连接暂时中断，已暂停。请检查网络并查看活动记录，核对本轮结果。';
  return '成员程序没能完成本轮，请查看活动记录中的原始报错。';
}
/** A correlated protocol response, distinct from a broken transport or missing receipt. */
export class NativeResponseError extends Error {
  constructor(message: string, readonly code?: number, readonly data?: unknown) { super(message); this.name = 'NativeResponseError'; }
}
