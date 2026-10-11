import type {Project} from './types';
export const PROJECT_TREE_METHODS=['project.move'] as const;
export interface ProjectRow {project:Project;depth:number;hasChildren:boolean;path:string[]}
/** Both old flat projects and damaged historical links remain visible. */
export function projectRows(projects:Project[],collapsed:ReadonlySet<string>=new Set()):ProjectRow[]{
  const work=projects.filter(p=>!p.kind),known=new Map(work.map(p=>[p.id,p])),children=new Map<string,Project[]>(),rows:ProjectRow[]=[],seen=new Set<string>();
  for(const p of work){const parent=p.parentId&&known.has(p.parentId)?p.parentId:'';children.set(parent,[...children.get(parent)??[],p]);}
  const sort=(a:Project,b:Project)=>(a.order??0)-(b.order??0)||a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id);
  function visit(p:Project,depth:number,parents:string[],hidden=false){if(seen.has(p.id))return;seen.add(p.id);const path=[...parents,p.name],kids=(children.get(p.id)??[]).sort(sort);if(!hidden)rows.push({project:p,depth,hasChildren:kids.length>0,path});for(const child of kids)visit(child,depth+1,path,hidden||collapsed.has(p.id));}
  for(const p of (children.get('')??[]).sort(sort))visit(p,0,[]);
  for(const p of work.sort(sort))if(!seen.has(p.id))visit(p,0,[]);
  return rows;
}
export function descendantIds(projects:Project[],projectId:string){const result=new Set<string>([projectId]);let changed=true;while(changed){changed=false;for(const p of projects)if(!p.kind&&p.parentId&&result.has(p.parentId)&&!result.has(p.id)){result.add(p.id);changed=true;}}return [...result];}
