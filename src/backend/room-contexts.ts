import { AsyncLocalStorage } from 'node:async_hooks';
import type { RoomId } from '../shared/types';
import type { RoomDiscussionController } from './room-discussion';
import type { Store } from './store';

export interface RoomContext {
  id:RoomId;store:Store;discussion:RoomDiscussionController;
  running?:Promise<void>;stopping:boolean;changing:boolean;
}
/** Async operations keep the room captured at their entry point, including timers and completions. */
export class RoomContexts {
  private readonly current=new AsyncLocalStorage<RoomId>();
  private readonly contexts=new Map<RoomId,RoomContext>();
  constructor(private store:Store,private create:(id:RoomId,store:Store)=>RoomDiscussionController){}
  get id(){return this.current.getStore()??'global';}
  get(roomId:RoomId=this.id):RoomContext {
    let context=this.contexts.get(roomId);
    if(!context){const store=this.store.roomScope(roomId);context={id:roomId,store,discussion:this.create(roomId,store),stopping:false,changing:false};this.contexts.set(roomId,context);}
    return context;
  }
  run<T>(roomId:RoomId,action:()=>T):T {return this.current.run(roomId,action);}
  get busy(){return [...this.contexts.values()].some(room=>room.running||room.changing);}
  all(){return [...this.contexts.values()];}
  forget(id:RoomId){this.contexts.delete(id);}
}
