import type { AdapterContext } from '../../shared/types';

/** Only ordinary room speech is tool-free. Desk work and auxiliary/task runs retain their tools. */
export function plainRoomSpeech(context: AdapterContext): boolean {
  return context.conversation === 'room' && !context.session.purpose && !context.session.writeMode
    && !context.run.flowOperationId && !context.run.imageGeneration;
}
