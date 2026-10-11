import { readFileSync, statSync } from 'node:fs';
import type { Evidence } from '../shared/project-flow';
import { resolveSafePath } from './security';

/** Source claims never become verified just because a member supplied event IDs or a confident label. */
export function bindSourceEvidence(evidence:Evidence[],root:string|undefined):Evidence[]{
  return evidence.map(e=>{
    if(e.kind!=='source')return e;
    const base={...e,source:'reported' as const,sourceVerification:'unverified' as const,eventIds:[]};
    if(/^https?:\/\//i.test(e.location??''))return {...base,sourceNote:'外部来源未在本机核实；请复核链接及引用，成员说明不等于原文。'};
    if(!root)return {...base,sourceNote:'来源文件不可读取，尚未核实。'};
    try{
      const location=(e.location??'').match(/^(.*?)(?::(\d+)(?:-(\d+))?|#L(\d+)(?:-L?(\d+))?)?$/)!;
      const file=resolveSafePath(root,location[1]),info=statSync(file);
      if(!info.isFile()||info.size>1024*1024||!(/\.(txt|md|csv|json|ya?ml|toml|log|html?|xml)$/i.test(file)))return {...base,sourceNote:'本机来源需可读取的文本原文；专用格式请提供 quote 或可核对摘录。'};
      let original=readFileSync(file,'utf8').replaceAll('\r\n','\n');
      const start=Number(location[2]??location[4]),end=Number(location[3]??location[5])||start;
      if(start){if(start<1||end<start||end-start>10000)return {...base,sourceNote:'来源位置无效，尚未核实。'};original=original.split('\n').slice(start-1,end).join('\n');}
      const matches=Boolean(e.excerpt?.trim())&&original.includes(e.excerpt!.replaceAll('\r\n','\n'));
      return {...base,sourceVerification:matches?'verified' as const:'mismatch' as const,sourceNote:matches?'已核对本机来源位置和原文引用。':'引用与本机来源位置的原文不一致。'};
    }catch{return {...base,sourceNote:'本机来源不存在、不可读取或超出成果副本，尚未核实。'};}
  });
}
