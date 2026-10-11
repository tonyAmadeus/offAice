import type {Snapshot, SnapshotPatch, PushEvent} from './types';

const rowKeys:Partial<Record<keyof Snapshot,string>>={projects:'id',sessions:'id',runs:'id',events:'id',approvals:'id',providers:'id',collaborations:'id',members:'id',removedMembers:'id',executors:'id',rooms:'roomId',projectFlows:'flowId',jointReviews:'id'};
const encode=(value:unknown)=>JSON.stringify(value);
type Row=Record<string,unknown>;

/** One ordered worker stream. Cache serialized values so later object mutation cannot hide a change. */
export class SnapshotPublisher {
  private revision=0;
  private fields=new Map<keyof Snapshot,string|undefined>();
  private rows=new Map<keyof Snapshot,Map<string,string>>();
  private orders=new Map<keyof Snapshot,string[]>();
  current?:Snapshot;
  constructor(private epoch:string){}
  publish(snapshot:Snapshot):Extract<PushEvent,{type:'snapshot'|'snapshot-patch'}>|undefined{
    const keys=new Set([...this.fields.keys(),...Object.keys(snapshot) as (keyof Snapshot)[]]);keys.delete('sync');
    const changes:Partial<Snapshot>={},removed:(keyof Snapshot)[]=[],rows:SnapshotPatch['rows']={};
    for(const key of keys){
      const value=snapshot[key],serialized=encode(value),prior=this.fields.get(key);
      if(this.revision&&serialized===prior)continue;
      if(value===undefined){removed.push(key);this.fields.delete(key);this.rows.delete(key);this.orders.delete(key);continue;}
      const identity=rowKeys[key];
      if(identity&&Array.isArray(value)){
        const items=value as Row[],order=items.map(item=>String(item[identity]));
        // Unexpected or duplicate identities fall back to an exact section replacement.
        if(items.every(item=>typeof item[identity]==='string')&&new Set(order).size===order.length){
          const before=this.rows.get(key),after=new Map(items.map(item=>[String(item[identity]),encode(item)!]));
          if(this.revision&&before){
            rows[key]={upsert:items.filter(item=>before.get(String(item[identity]))!==after.get(String(item[identity]))),removed:[...before.keys()].filter(id=>!after.has(id)),...(encode(order)!==encode(this.orders.get(key))?{order}:{})};
          }else Object.assign(changes,{[key]:value});
          this.rows.set(key,after);this.orders.set(key,order);
        }else{Object.assign(changes,{[key]:value});this.rows.delete(key);this.orders.delete(key);}
      }else Object.assign(changes,{[key]:value});
      this.fields.set(key,serialized);
    }
    if(this.revision&&!Object.keys(changes).length&&!removed.length&&!Object.keys(rows).length)return;
    const baseRevision=this.revision,sync={epoch:this.epoch,revision:++this.revision};
    this.current={...snapshot,sync};
    return baseRevision?{type:'snapshot-patch',sync,baseRevision,changes,removed,rows}:{type:'snapshot',snapshot:this.current};
  }
}

/** Undefined requests an authoritative resync; duplicate/late packets leave the current view intact. */
export function applySnapshotPatch(current:Snapshot,patch:SnapshotPatch):Snapshot|undefined{
  if(current.sync?.epoch!==patch.sync.epoch)return;
  if(patch.sync.revision<=current.sync.revision)return current;
  if(patch.baseRevision!==current.sync.revision)return;
  const next={...current,...patch.changes,sync:patch.sync};
  for(const key of patch.removed)delete (next as unknown as Record<string,unknown>)[key];
  for(const [name,delta] of Object.entries(patch.rows)){
    const key=name as keyof Snapshot,identity=rowKeys[key],old=next[key];
    if(!identity||!Array.isArray(old))return;
    const items=new Map((old as Row[]).map(item=>[String(item[identity]),item]));
    for(const id of delta.removed)items.delete(id);
    for(const item of delta.upsert){if(typeof item[identity]!=='string')return;items.set(String(item[identity]),item);}
    const order=delta.order??[...items.keys()];
    if(order.length!==items.size||new Set(order).size!==order.length||order.some(id=>!items.has(id)))return;
    Object.assign(next,{[key]:order.map(id=>items.get(id))});
  }
  return next;
}

export function acceptSnapshot(current:Snapshot,incoming:Snapshot):Snapshot{
  return current.sync&&incoming.sync?.epoch===current.sync.epoch&&incoming.sync.revision<current.sync.revision?current:incoming;
}
