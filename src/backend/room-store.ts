import type { RoomId, RoomMessage, RoomThread } from '../shared/types';
import type { Store } from './store';

/** A controller owns this fixed store view for its lifetime. No UI cursor selects its room. */
export function scopedRoomStore(store:Store,roomId:RoomId):Store {
  const belongs=(entity:string,value:any)=>entity==='room_threads'?(value?.roomId??'global')===roomId:entity==='room_messages'?Boolean(value&&store.get<RoomThread>('room_threads',value.threadId??'room-main')?.roomId===roomId):true;
  const get=(entity:string,id:string)=>{
    if(entity==='room'&&id==='state')return store.roomState(roomId);
    if(entity==='room'&&id==='current')return {id:store.currentRoomThread(roomId).id};
    const value=store.get(entity,id);return belongs(entity,value)?value:undefined;
  };
  const write=(entity:string,id:string,value:any)=>{
    if(entity==='room'&&(id==='state'||id==='current')){if(id==='current')store.roomThread(value.id,roomId);return {entity:id==='state'?'room_states':'room_cursors',id:roomId,value};}
    if(entity==='room_threads'){
      const existing=store.get<RoomThread>(entity,id);
      if(existing&&!belongs(entity,existing)||value.roomId&&value.roomId!==roomId)throw new Error('不能修改其他房间的话题');
      if(value.inherited)store.roomThread(value.inherited.threadId,roomId);
      value={...value,roomId,...(roomId.startsWith('project:')?{projectId:roomId.slice(8)}:{})};
    }
    if(entity==='room_messages'){
      const existing=store.get<RoomMessage>(entity,id);
      if(existing&&!belongs(entity,existing))throw new Error('不能修改其他房间的消息');
      store.roomThread(value.threadId??store.currentRoomThread(roomId).id,roomId);
      value={...value,threadId:value.threadId??store.currentRoomThread(roomId).id};
      for(const ref of [value.replyTo,value.inReplyTo])if(ref&&!get('room_messages',ref))throw new Error('回复消息不属于当前房间');
    }
    return {entity,id,value};
  };
  const methods:Record<string,unknown>={
    get,
    put:(entity:string,id:string,value:unknown)=>{const item=write(entity,id,value);store.put(item.entity,item.id,item.value);},
    putMany:(items:{entity:string;id:string;value:unknown}[])=>store.putMany(items.map(item=>write(item.entity,item.id,item.value))),
    list:(entity:string)=>store.list(entity).filter(value=>belongs(entity,value)),
    delete:(entity:string,id:string)=>{const existing=store.get(entity,id);if(existing&&!belongs(entity,existing))throw new Error('不能删除其他房间的记录');store.delete(entity,id);},
    roomState:()=>store.roomState(roomId),currentRoomThread:()=>store.currentRoomThread(roomId),roomThreads:()=>store.roomThreads(roomId),
    roomHistory:(threadId?:string,before?:string,limit?:number)=>store.roomHistory(threadId,before,limit,roomId),
    roomMessages:(limit?:number,threadId?:string)=>store.roomMessages(limit,threadId,roomId),
    allRoomMessages:(threadId:string)=>store.allRoomMessages(threadId,roomId),
    clearRoomThread:(threadId:string)=>store.clearRoomThread(threadId,roomId),
    archiveRoom:(title?:string,inherited?:RoomThread['inherited'])=>{if(roomId!=='global')throw new Error('项目会议室使用固定话题，无需归档');return store.archiveRoom(title,inherited);},
    removeArchivedRoomThread:(threadId:string,removeRecords?:()=>void)=>{store.roomThread(threadId,roomId);return store.removeArchivedRoomThread(threadId,removeRecords);},
  };
  return new Proxy(store,{get(target,key){if(typeof key==='string'&&key in methods)return methods[key];const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
}
