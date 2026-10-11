import type { Collaboration, Project } from '../shared/types';
import type { Store } from './store';

/** Read-only legacy records keep their pause marker; current work uses roundtables and project flows. */
export class LegacyCollaborations {
  constructor(private store:Store,private changed:()=>void){}
  pause(id:string){
    const collaboration=this.store.get<Collaboration>('collaborations',id);
    if(!collaboration)throw new Error('所选记录不存在，请刷新工作台');
    const project=this.store.get<Project>('projects',collaboration.projectId);
    this.store.transaction(()=>{
      this.store.put('collaborations',id,{...collaboration,status:'paused',stage:collaboration.status==='paused'?collaboration.stage:`已暂停新交接 · ${collaboration.stage}`});
      if(project)this.store.put('projects',project.id,{...project,collaborationPaused:true});
    });
    this.changed();
    return {paused:true};
  }
  resume(_id:string){
    throw new Error('旧协作记录只供阅读；共同评审请在圆桌开新议题，项目工作请在会议室启动流程。');
  }
}
