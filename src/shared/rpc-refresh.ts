import {PROJECT_FLOW_READS} from './project-flow';
import {ROUNDTABLE_READS} from './roundtable';

/** Status polling and view reads do not change the workbench. Mutations publish their own snapshots. */
const NO_REFRESH=new Set(['composer.draft.get','composer.draft.save','snapshot','artifact.read','artifact.list','project.diff','dialog.directory','dialog.program','workspace.open','room.get','room.history','room.export','room.send','report.work','session.events','catalog.list','catalog.latest','catalog.installation','executor.loginStatus','member.versions','member.installation','provider.config','provider.compatibility','attention.list','backup.list','backup.preview','app.version','catalog.openLink','executor.openLogin','window.attention','window.show',...PROJECT_FLOW_READS,...ROUNDTABLE_READS]);
export const refreshAfterRpc=(method:string)=>!NO_REFRESH.has(method)&&!['settings.save','provider.loginStatus','provider.openLogin'].includes(method);
