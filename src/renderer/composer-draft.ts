import {useEffect,useRef,useState} from 'react';
import {composerDraftId,emptyComposerDraft,hasComposerDraft,remainingComposerDraft,type ComposerDraft,type ComposerScope} from '../shared/composer-draft';
import type {Invoke} from './ui';

type Cached={value:ComposerDraft;version:number};
const cache=new Map<string,Cached>(),writes=new Map<string,Promise<unknown>>();
type Pending={value:ComposerDraft;promise:Promise<unknown>};
const pending=new Map<string,Pending>();
const storageKey=(dataDirectory:string,scope:ComposerScope)=>'airoom.composer.draft:'+JSON.stringify([dataDirectory,scope.restoreEpoch??'',composerDraftId(scope)]);
function read(key:string):Cached|undefined{
  if(cache.has(key))return cache.get(key);
  try{const item=JSON.parse(localStorage.getItem(key)??'null');if(item&&typeof item.value?.text==='string'&&Array.isArray(item.value.attachments)){cache.set(key,item);return item;}}catch{}
}
function remember(key:string,item:Cached){
  cache.set(key,item);
  try{if(hasComposerDraft(item.value))localStorage.setItem(key,JSON.stringify(item));else localStorage.removeItem(key);}catch{/* The backend copy is still saved; an open composer also retains its in-memory value. */}
}
function persist(key:string,scope:ComposerScope,value:ComposerDraft,invoke:Invoke){
  const old=pending.get(key);if(old){old.value=value;return old.promise;}
  let resolve!:(value:unknown)=>void,reject!:(reason:unknown)=>void;
  const next:Pending={value,promise:new Promise((yes,no)=>{resolve=yes;reject=no;})};pending.set(key,next);
  // Keep immediate navigation safe locally, coalesce typing before ordered database writes.
  setTimeout(()=>{
    pending.delete(key);
    const task=(writes.get(key)??Promise.resolve()).catch(()=>{}).then(()=>invoke('composer.draft.save',{...scope,value:next.value},undefined,{background:true}));
    writes.set(key,task);void task.then(resolve,reject).finally(()=>{if(writes.get(key)===task)writes.delete(key);});
  },150);
  return next.promise;
}

/** Synchronous local cache survives immediate navigation; ordered backend saves keep attachments and backups. */
export function useComposerDraft(dataDirectory:string,scope:ComposerScope|undefined,invoke:Invoke){
  const key=scope?storageKey(dataDirectory,scope):'',active=useRef(key),api=useRef(invoke);
  active.current=key;api.current=invoke;
  const [,render]=useState(0),[error,setError]=useState('');
  const item=key?read(key):undefined,value=item?.value??emptyComposerDraft();
  function save(next:ComposerDraft){
    if(!key||!scope)return;
    const version=(read(key)?.version??0)+1;remember(key,{value:next,version});render(n=>n+1);
    void persist(key,scope,next,api.current).then(()=>{if(active.current===key&&read(key)?.version===version)setError('');}).catch(()=>{if(active.current===key&&read(key)?.version===version)setError('草稿暂存在当前窗口，尚未写入本机资料。请恢复连接后重试。');});
  }
  useEffect(()=>{
    setError('');if(!scope||!key)return;
    const old=read(key);let current=true;
    if(old){void persist(key,scope,old.value,api.current).catch(()=>{if(current)setError('草稿尚未写入本机资料。请恢复连接后重试。');});}
    else void api.current<ComposerDraft|null>('composer.draft.get',scope,undefined,{background:true}).then(stored=>{
      if(stored&&typeof stored.text==='string'&&Array.isArray(stored.attachments)&&!read(key)){remember(key,{value:stored,version:0});if(current)render(n=>n+1);}
    }).catch(()=>{if(current)setError('暂时无法读取已保存的草稿，请恢复连接后重试。');});
    return()=>{current=false;};
  },[key]);
  return {value,version:item?.version??0,error,ready:Boolean(key),hasDraft:hasComposerDraft(value),
    update:(change:(previous:ComposerDraft)=>ComposerDraft)=>save(change(read(key)?.value??emptyComposerDraft())),
    clear:(expectedVersion?:number)=>{if(expectedVersion!==undefined&&(read(key)?.version??0)!==expectedVersion)return false;save(emptyComposerDraft());return true;},
    sent:(submitted:ComposerDraft,version:number)=>{const current=read(key);save((current?.version??0)===version?emptyComposerDraft():remainingComposerDraft(current?.value??emptyComposerDraft(),submitted));},
    retry:()=>save(read(key)?.value??emptyComposerDraft()),
  };
}
