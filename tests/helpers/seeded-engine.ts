import {Engine as ProductionEngine} from '../../src/backend/engine';
import {Store as ProductionStore} from '../../src/backend/store';
import {BUILTIN_MEMBERS} from '../../src/shared/defaults';

/** Existing scenarios explicitly opt into a team fixture. Production starts with no members. */
export class Engine extends ProductionEngine {
  constructor(...args:ConstructorParameters<typeof ProductionEngine>){
    const store=new Store(args[0]);
    store.close();
    super(...args);
  }
}
export class Store extends ProductionStore {
  constructor(directory:string){super(directory);if(!this.get('test_fixtures','seeded-team')){for(const member of BUILTIN_MEMBERS)if(!this.get('members',member.id)&&!this.get('removed_members',member.id))this.put('members',member.id,member);this.put('test_fixtures','seeded-team',{done:true});}}
}
