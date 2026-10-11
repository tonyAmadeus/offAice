import './helpers/roundtable-harness';
import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,readFile,access} from 'node:fs/promises';
import path from 'node:path';
import type {Project} from '../src/shared/types';
import type {RoundtableDetail} from '../src/shared/roundtable';
import {roundtableHarness} from './helpers/roundtable-harness';
import {withProjectWrite} from '../src/backend/project-access';
import {workspaceFingerprint} from '../src/backend/workspace';

for(const mode of ['saved-project-file','picked-project-folder'])test('roundtable '+mode+' waits for a shared-directory write before freezing its material',async()=>{
  const h=await roundtableHarness();let release!:()=>void,entered!:()=>void,opening:Promise<RoundtableDetail>|undefined,writing:Promise<void>|undefined;
  const gate=new Promise<void>(r=>release=r),ready=new Promise<void>(r=>entered=r);
  try{
    const project=await h.engine.invoke('project.create',{directory:h.original,name:'材料来源'}) as Project;
    await writeFile(path.join(h.original,'second.md'),'旧的第二份资料');
    writing=withProjectWrite(h.engine.store,project.id,h.original,async check=>{check();await writeFile(path.join(h.original,'brief.md'),'写回中间状态');entered();await gate;await writeFile(path.join(h.original,'brief.md'),'写回完成的材料');await writeFile(path.join(h.original,'second.md'),'写回完成的第二份材料');check();});await ready;
    opening=mode==='saved-project-file'?h.engine.invoke('project.toRoundtable',{requestId:'queued-material',projectId:project.id,source:{path:'brief.md'},kind:'review',memberIds:['codex','claude'],synthesizerId:'codex'}) as Promise<RoundtableDetail>:h.open({kind:'review',material:{text:'评审这个项目文件夹',directory:h.original},memberIds:['codex','claude']});
    const until=Date.now()+3000;while(!h.engine.snapshot().roundtable?.topics.length){if(Date.now()>until)throw Error('topic not published');await new Promise(r=>setTimeout(r,10));}
    await new Promise(r=>setTimeout(r,70));assert.equal(h.calls.length,0);assert.equal(h.engine.snapshot().roundtable!.topics[0].status,'preparing');
    release();await writing;const original=await workspaceFingerprint(h.original),topic=(await opening).topic;
    await h.minutes(topic.id);const material=h.engine.store.get<{root:string}>('flow_artifacts',(await h.get(topic.id)).topic.materialVersion!.artifactId)!;
    assert.equal(await readFile(path.join(material.root,'brief.md'),'utf8'),'写回完成的材料');
    if(mode==='picked-project-folder')assert.equal(await readFile(path.join(material.root,'second.md'),'utf8'),'写回完成的第二份材料');else await assert.rejects(access(path.join(material.root,'second.md')),/ENOENT/);
    assert.equal(await workspaceFingerprint(h.original),original);assert.ok(h.calls.length>0);
  }finally{release();await writing;await opening;await h.dispose();}
});
