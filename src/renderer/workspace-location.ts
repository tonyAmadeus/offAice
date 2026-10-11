import type {Session} from '../shared/types';

export function workspaceLocation(session:Session|undefined,directory?:string){
  const path=session?.workspace??directory??'';
  const mode=session?.restoredHistoryOnly?'只读历史':session&&!session.writeMode?'只读查看':session?.workspaceKind==='original'?'直接读写':session?.workspace?'任务副本':'待创建任务副本';
  const hint=mode==='直接读写'?'改动直接保存到这里。':mode==='只读查看'||mode==='只读历史'?'本话题不修改文件。':session?.workspace?'改动保存在此副本，应用后写回原文件夹。':'第一次执行时创建独立副本，原文件夹作为来源。';
  return {path,mode,hint,label:`${mode}：${path||'尚未选择文件夹'}`};
}
