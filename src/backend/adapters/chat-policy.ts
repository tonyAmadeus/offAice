import type { AdapterContext } from '../../shared/types';

/** Only ordinary room speech is tool-free. Desk work and auxiliary/task runs retain their tools. */
export function plainRoomSpeech(context: AdapterContext): boolean {
  return context.conversation === 'room' && !context.session.purpose && !context.session.writeMode
    && !context.run.flowOperationId && !context.run.imageGeneration;
}

/** Read-only file tools offered to project meeting-room speech (Claude Code and ZCode names). */
export const ROOM_READ_TOOLS = ['Read', 'Glob', 'Grep'];

/** Project meeting-room speech and @ replies may read the bound project, never change it.
 * Hand ballots, minutes, images, writes and flow work keep their own rules. */
export function roomProjectFiles(context: AdapterContext): string | undefined {
  const purpose = context.session.purpose;
  return context.conversation === 'room' && context.roomProjectDirectory && !context.session.writeMode
    && !context.run.flowOperationId && !context.run.imageGeneration && (!purpose || purpose === 'room-mention')
    ? context.roomProjectDirectory : undefined;
}
