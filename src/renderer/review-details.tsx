import type {CriterionAssessment,Evidence} from '../shared/project-flow';
import type {Invoke} from './ui';
import {useEffect,useState} from 'react';

const RATING={meets:'符合',partly:'部分符合 · 建议',not:'不符合'};
export function ReviewDetails({assessments,strengths,sources,owner,projectId,invoke,artifactId}:{assessments?:CriterionAssessment[];strengths?:string[];sources?:Evidence[];owner?:string[];projectId:string;invoke:Invoke;artifactId?:string}){
  const [excerpt,setExcerpt]=useState(''),[error,setError]=useState('');
  useEffect(()=>{setExcerpt('');setError('');},[artifactId,projectId]);
  async function open(location:string){
    const file=location.replace(/(?::\d+(?:-\d+)?|#L\d+(?:-L?\d+)?)$/,'');
    try{setError('');if(artifactId){const result=await invoke<{content:string}>('projectFlow.artifact.read',{artifactId,path:file});setExcerpt(result.content);}else await invoke('project.openPath',{projectId,path:file,action:'reveal'});}
    catch(e){setError((e as Error).message);}
  }
  return <div className="review-details">
    {owner?.length? <section><h4>需要你判断的几点</h4><ul>{owner.map(c=><li key={c}>{c}</li>)}</ul></section>:null}
    {assessments?.length?<section><h4>成员的评价</h4><ul>{assessments.map(a=><li key={a.criterion}><strong>{RATING[a.rating]} · {a.criterion}</strong><p>{a.reason}</p></li>)}</ul></section>:null}
    {strengths?.length?<section><h4>做得好的地方</h4><ul>{strengths.map((s,i)=><li key={i}>{s}</li>)}</ul></section>:null}
    {sources?.some(e=>e.kind==='source')?<section><h4>来源依据</h4><ul>{sources.filter(e=>e.kind==='source').map((e,i)=><li key={i}>
      {/^(https?):\/\//i.test(e.location??'')?<a href={e.location} target="_blank" rel="noreferrer">{e.title}</a>:<button type="button" className="link-button" onClick={()=>void open(e.location??'')}>{e.title}</button>}
      <small> · {e.sourceVerification==='verified'?'已核对本机原文':e.sourceVerification==='mismatch'?'引用不一致':'未核实来源'} · {e.location}</small>
      <blockquote>{e.excerpt}</blockquote><p className="task-meta">{e.sourceNote}</p>
    </li>)}</ul></section>:null}
    {error&&<p role="alert" className="task-meta bad">{error}</p>}{excerpt&&<details open><summary>本次成果版本里的来源原文 <button className="link-button" onClick={()=>setExcerpt('')}>收起</button></summary><pre>{excerpt}</pre></details>}
  </div>;
}
