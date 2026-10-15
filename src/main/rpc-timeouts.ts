const LONG_OPERATIONS=new Set(['room.compress','room.archive','executor.authenticate']);
const WORKSPACE_OPERATIONS=new Set(['project.remove','session.delete','room.clear','room.uninherit','attachment.import','workspace.apply','workspace.discard','workspace.undo','workspace.undo.info']);
const PROVIDER_OPERATIONS=new Set(['member.versions','provider.balance','provider.quota']);
// A connection check starts the member program several times; right after a download it starts cold.
const CONNECTION_CHECKS=new Set(['provider.probe','member.use']);

export function rpcTimeout(method:string){
  if(method.startsWith('backup.'))return 10*60_000;
  if(method==='room.end')return 180_000;
  if(method==='catalog.install')return 20*60_000;
  if(['catalog.use','catalog.latest'].includes(method))return 180_000;
  if(method==='member.install')return 16*60_000;
  if(LONG_OPERATIONS.has(method))return 10*60_000;
  if(WORKSPACE_OPERATIONS.has(method))return 180_000;
  if(CONNECTION_CHECKS.has(method))return 180_000;
  if(PROVIDER_OPERATIONS.has(method))return 90_000;
  return 45_000;
}
export function rpcTimeoutMessage(method:string){
  const names:Record<string,string>={'snapshot':'读取工作台状态','settings.save':'保存设置','catalog.list':'读取执行端清单','catalog.install':'下载与配置执行端','catalog.installation':'读取下载进度','member.installation':'读取下载进度','member.versions':'读取执行端版本','executor.loginStatus':'读取登录状态','executor.authenticate':'官方登录','provider.probe':'检查连接','room.get':'读取对话','room.history':'读取历史记录'};
  return `${names[method]??'当前操作'}未及时响应；请先核对当前状态。停止按钮仍可直接关闭本应用的执行进程。`;
}
