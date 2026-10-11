import { useState } from 'react';
import type { CompatibilityReport } from '../shared/compatibility';
import type { ProviderInfo } from '../shared/types';

const stages:Record<string,string>={initialize:'协议初始化',account:'账户确认',configuration:'配置协商','session-load':'恢复会话','session-new':'创建会话',dispatch:'发送并等待结果',cancel:'取消',close:'关闭'};
const outcomes:Record<string,string>={running:'进行中',passed:'通过','needs-auth':'程序就绪，需要登录',failed:'失败',unknown:'结果未知',stopped:'已停止'};
export function CompatibilityDetails({provider,info,available,load}:{provider:string;info?:ProviderInfo;available:boolean;load:(provider:string)=>Promise<unknown>}){
  const [reports,setReports]=useState<CompatibilityReport[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState('');
  async function refresh(){setBusy(true);setError('');try{const result=await load(provider);setReports(Array.isArray(result)?result:[]);}catch(cause){setError((cause as Error).message);}finally{setBusy(false);}}
  const shown=reports.length?reports:info?.compatibility?[info.compatibility]:[];
  return <>{info?.lastRunCompatibility&&['failed','unknown'].includes(info.lastRunCompatibility.outcome)&&<p className="provider-detail">最近实际运行：{outcomes[info.lastRunCompatibility.outcome]}（{new Date(info.lastRunCompatibility.startedAt).toLocaleString()}）。最近连接检查与运行结果分别保留，请展开诊断核对。</p>}<details className="provider-detail"><summary>连接诊断与历史</summary>
    <p>账户登录、连接检查和实际运行分别记录。探测通过不代表后续模型调用一定成功。</p>
    <button type="button" className="button small secondary" disabled={busy||!available} onClick={()=>void refresh()}>{busy?'正在读取…':'读取最近记录'}</button>
    {error&&<p role="alert">{error}</p>}
    {!shown.length&&<p>尚无分阶段记录；下一次检查或运行后生成。</p>}
    {shown.slice(0,20).map(report=><details key={report.id}><summary>{new Date(report.startedAt).toLocaleString()} · {report.trigger==='run'?'实际运行':report.trigger==='candidate'?'候选版本':report.trigger==='configuration'?'配置读取':'连接检查'} · {outcomes[report.outcome]??report.outcome}</summary>
      <p>账户：{report.account??'本次未单独确认'}；投递：{report.delivery??'未发送工作'}；恢复：{report.restore==='current-version'?'使用当前版本继续原会话':report.restore==='bound'?'当时使用绑定版本':report.restore==='legacy-unbound'?'历史版本未知':report.restore==='new'?'新会话':'未验证历史恢复'}</p>
      <p>执行端：{report.identity.path??'未能定位'}<br/>版本：{report.identity.version??'未报告'}{report.identity.versionSource==='manifest'?'（包清单）':''} · {report.identity.adapterVersion} · {report.identity.protocol}{report.identity.protocolVersion?' / '+report.identity.protocolVersion:''}</p>
      <p>运行环境：{report.nodeRuntime?.source==='portable'?'官方便携备用':report.nodeRuntime?.source==='local'?'本机 Node.js':'AIROOM 自带'} {report.nodeRuntime?.version??'历史记录未提供'}{report.nodeRuntime?.detail?' · '+report.nodeRuntime.detail:''}</p>
      <p>网络：{report.network.mode}{report.network.proxyHost?' · '+report.network.proxyHost:''}{report.network.mode==='tun'?'（系统 TUN 状态未独立确认）':''}</p>
      <p>请求配置：{report.configuration?.model??'程序默认'} · {report.configuration?.effort??'默认思考程度'}</p>
      {report.error&&<pre className="login-message">{report.error}</pre>}
      <ul>{report.stages.map((step,index)=><li key={index}>{stages[step.stage]??step.stage}{step.method?' / '+step.method:''}：{outcomes[step.outcome]} · {step.durationMs} ms{step.timeoutMs?`（上限 ${step.timeoutMs} ms）`:''}{step.error&&<pre className="login-message">{step.error}</pre>}</li>)}</ul>
    </details>)}
  </details></>;
}
