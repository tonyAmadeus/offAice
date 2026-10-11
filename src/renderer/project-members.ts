import type { Project, Snapshot } from '../shared/types';
import type { Invoke } from './ui';

/** Who takes part in a project's meeting room, chosen in 请大家一起来 and kept on the project (Project.memberIds).
 *  A saved list wins, including an intentionally empty one. Before the backend stored it, the choice lived in this
 *  browser's storage; that copy is read only while the project has no saved list, and moved over on first use. */
const KEY = (projectId: string) => `airoom.project.members:${projectId}`;

function legacyMembers(projectId: string): string[] | undefined {
  try { const saved = JSON.parse(localStorage.getItem(KEY(projectId)) ?? 'null'); if (Array.isArray(saved)) return saved.filter((id): id is string => typeof id === 'string'); } catch {}
  return undefined;
}

export function projectMembers(project: Pick<Project, 'id' | 'memberIds'>): string[] {
  if (Array.isArray(project.memberIds)) return project.memberIds;
  return legacyMembers(project.id) ?? [];
}

export async function saveProjectMembers(invoke: Invoke, projectId: string, memberIds: string[]) {
  await invoke('project.update', { projectId, memberIds });
  try { localStorage.removeItem(KEY(projectId)); } catch {}
}

/** Moves a list kept by an older version onto the project, unless the project already has one. */
export async function migrateProjectMembers(invoke: Invoke, project: Pick<Project, 'id' | 'memberIds'>) {
  if (Array.isArray(project.memberIds)) { try { localStorage.removeItem(KEY(project.id)); } catch {} return; }
  const legacy = legacyMembers(project.id);
  if (legacy?.length) await saveProjectMembers(invoke, project.id, legacy).catch(() => {});
}

/** A project needs people before its room is useful: none chosen yet, and no flow that already names its team. */
export function needsMembers(snapshot: Snapshot, project: Project) {
  return !projectMembers(project).length && !snapshot.projectFlows?.some(flow => flow.projectId === project.id);
}
