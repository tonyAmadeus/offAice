import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {SnapshotPublisher,applySnapshotPatch,acceptSnapshot} from '../src/shared/snapshot-sync';
import {DEFAULT_SETTINGS} from '../src/shared/defaults';
import type {Snapshot,SnapshotPatch} from '../src/shared/types';
const initial=():Snapshot=>({projects:[],sessions:[],runs:[],events:[],approvals:[],providers:[],settings:DEFAULT_SETTINGS,collaborations:[],dataDirectory:'fixture',backendReady:true,deepseekKeyConfigured:false,members:[],profile:{name:'owner'},room:{messages:[],state:{active:false,mode:'chat'}}});
function change(publisher:SnapshotPublisher,value:Snapshot){const event=publisher.publish(value);assert.equal(event?.type,'snapshot-patch');return event as SnapshotPatch;}

test('snapshot stream sends only changed rows, retains order, removes records and optional sections exactly',()=>{
  const p=new SnapshotPublisher('worker-1'),source=initial();source.projects=[{id:'a',name:'A',directory:'a',createdAt:'',collaborationPaused:false},{id:'b',name:'B',directory:'b',createdAt:'',collaborationPaused:false}];source.roundtable={topics:[]};
  const first=p.publish(source);assert.equal(first?.type,'snapshot');let view=structuredClone(p.current!);
  const next={...source,projects:[source.projects[1],{...source.projects[0],name:'changed'},{id:'c',name:'C',directory:'c',createdAt:'',collaborationPaused:false}]};
  const patch=change(p,next);assert.deepEqual(Object.keys(patch.changes),[]);assert.deepEqual(patch.rows.projects.upsert.map(row=>row.id),['a','c']);assert.deepEqual(patch.rows.projects.order,['b','a','c']);
  const oldSettings=view.settings;view=applySnapshotPatch(view,structuredClone(patch))!;assert.equal(view.settings,oldSettings);assert.deepEqual(view.projects,next.projects);
  const removed={...next,projects:[next.projects[1]],roundtable:undefined};view=applySnapshotPatch(view,change(p,removed))!;assert.deepEqual(view.projects,removed.projects);assert.equal('roundtable' in view,false);assert.equal(p.publish(removed),undefined);
});

test('duplicates and stale full responses cannot roll back state; gaps and restarted streams require a full snapshot',()=>{
  const p=new SnapshotPublisher('one'),source=initial();p.publish(source);const first=structuredClone(p.current!);
  const patch=change(p,{...source,profile:{name:'new'}}),view=applySnapshotPatch(first,patch)!;
  assert.equal(applySnapshotPatch(view,patch),view);assert.equal(acceptSnapshot(view,first),view);
  const later=change(p,{...source,profile:{name:'latest'}});assert.equal(applySnapshotPatch(first,later),undefined);
  const other=new SnapshotPublisher('two');other.publish(source);assert.equal(applySnapshotPatch(other.current!,patch),undefined);
  assert.equal(acceptSnapshot(view,other.current!),other.current);
});

test('mutating a source object after publication is detected, and missing row identities fall back to exact sections',()=>{
  const p=new SnapshotPublisher('one'),source=initial();p.publish(source);const view=structuredClone(p.current!);source.profile.name='changed';
  assert.equal(applySnapshotPatch(view,change(p,source))?.profile.name,'changed');
  source.projectFlows=[{projectId:'p'}] as Snapshot['projectFlows'];const patch=change(p,source);assert.deepEqual(patch.changes.projectFlows,source.projectFlows);assert.equal(patch.rows.projectFlows,undefined);
});

test('a streamed event arriving before its snapshot row is retained once and follows canonical order',()=>{
  const p=new SnapshotPublisher('one'),source=initial();p.publish(source);const event={id:'e1',runId:'r',sessionId:'s',provider:'codex' as const,at:'',kind:'delta' as const,text:'once',fidelity:'native' as const};
  const view={...structuredClone(p.current!),events:[event]},patch=change(p,{...source,events:[event]});
  const next=applySnapshotPatch(view,patch)!;assert.deepEqual(next.events,[event]);assert.equal(next.events.length,1);
});
