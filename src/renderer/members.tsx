import { createContext, useContext, useState, type CSSProperties, type SyntheticEvent } from 'react';
import type { MemberProfile, PermissionMember, ProviderInfo, Run, Session } from '../shared/types';
import { BUILTIN_MEMBERS, PORTRAIT_SCALE, PROVIDER_NAMES } from '../shared/defaults';
import claudiaArt from './assets/members/claudia.webp';
import gptiaArt from './assets/members/gptia.webp';
import dsArt from './assets/members/ds.webp';
import geminiArt from './assets/members/gemini.webp';

/** Built-in artwork and where the face sits in it (fractions of the artwork). */
const BUILTIN_ART: Record<string, { art: string; face: { x: number; y: number; zoom: number }; aspect: number }> = {
  claude: { art: claudiaArt, face: { x: 0.5, y: 0.123, zoom: 3.6 }, aspect: 1720 / 960 },
  codex: { art: gptiaArt, face: { x: 0.487, y: 0.113, zoom: 3.6 }, aspect: 1720 / 960 },
  dsh: { art: dsArt, face: { x: 0.533, y: 0.118, zoom: 3.3 }, aspect: 1344 / 750 },
  gemini: { art: geminiArt, face: { x: 0.49, y: 0.128, zoom: 3.6 }, aspect: 1720 / 960 },
};
export const assetUrl = (file: string) => `airoom-asset://local/${encodeURIComponent(file)}`;

/** A teammate as the interface shows them: their card merged with built-in art and defaults. */
export interface TeamMember {
  id: string; executor: PermissionMember; name: string; product: string; motto: string; color: string;
  /** Full portrait (built-in art or an uploaded image); absent means an initial is shown. */
  art?: string; aspect?: number;
  /** A separate avatar image: fills the circle, or follows avatarFace when the user framed it. */
  avatarImage?: string; avatarFace?: { x: number; y: number; zoom: number };
  face: { x: number; y: number; zoom: number };
  userTitle?: string; persona?: string; memory?: string; model?: string; effort?: string;
  builtIn: boolean; card: MemberProfile;
}

export function buildTeam(profiles: MemberProfile[]): TeamMember[] {
  return profiles.map(card => {
    const builtIn = BUILTIN_ART[card.id];
    const art = card.portrait ? assetUrl(card.portrait) : card.builtIn ? builtIn?.art : undefined;
    return {
      id: card.id, executor: card.executor, name: card.name, product: PROVIDER_NAMES[card.executor], motto: card.motto ?? '',
      color: card.color ?? BUILTIN_MEMBERS.find(member => member.id === card.id)?.color ?? '#8a6a52',
      art, aspect: card.portrait ? undefined : builtIn?.aspect, avatarImage: card.avatar ? assetUrl(card.avatar) : undefined, avatarFace: card.avatar ? card.avatarFace : undefined,
      face: card.face ?? (card.portrait ? { x: 0.5, y: 0.15, zoom: 3 } : builtIn?.face ?? { x: 0.5, y: 0.15, zoom: 3 }),
      userTitle: card.userTitle, persona: card.persona, memory: card.memory, model: card.model, effort: card.effort,
      builtIn: Boolean(card.builtIn), card,
    };
  });
}

/** The seat kept for teammates who are not connected yet. */
export const GEMINI_SEAT: TeamMember = {
  id: 'gemini', executor: 'claude', name: 'Gemini', product: '尚未接入', motto: '星星还在路上，很快见。', color: '#a35bdb',
  art: geminiArt, aspect: BUILTIN_ART.gemini.aspect, face: BUILTIN_ART.gemini.face, builtIn: true,
  card: { id: 'gemini', executor: 'claude', name: 'Gemini' },
};

export interface Team {
  members: TeamMember[];
  get(id: string | undefined): TeamMember | undefined;
  /** The original identity of a session, including retained history of deleted cards. */
  ofSession(session: Pick<Session, 'provider' | 'memberId'> | undefined): TeamMember;
  /** The member who ran a turn (through its session). */
  ofRun(run: Pick<Run, 'provider' | 'sessionId'>, sessions: Session[]): TeamMember;
}
const defaultArtwork = buildTeam(BUILTIN_MEMBERS);
function displayFallback(id?:string):TeamMember {
  return defaultArtwork.find(member=>member.id===id)??buildTeam([{id:id??'unknown',executor:'claude',name:id??'成员'}])[0];
}
export function makeTeam(profiles: MemberProfile[], removedProfiles: MemberProfile[] = []): Team {
  const members = buildTeam(profiles);
  const historical = buildTeam(removedProfiles);
  const get = (id: string | undefined) => id === 'gemini' ? GEMINI_SEAT : members.find(member => member.id === id)??historical.find(member=>member.id===id);
  const ofSession: Team['ofSession'] = session => session ? get(session.memberId??session.provider)??displayFallback(session.memberId??session.provider) : members[0]??displayFallback();
  return { members, get, ofSession, ofRun: (run, sessions) => ofSession(sessions.find(session => session.id === run.sessionId) ?? { provider: run.provider }) };
}
const TeamContext = createContext<Team>(makeTeam(BUILTIN_MEMBERS));
export const TeamProvider = TeamContext.Provider;
export const useTeam = () => useContext(TeamContext);
export const memberIdOf = (session: Pick<Session, 'provider' | 'memberId'>) => session.memberId ?? session.provider;

/** Per-member colour classes, generated so uploaded members get the same treatment as the built-ins. */
export function TeamColors({ team }: { team: Team }) {
  const css = [...team.members, GEMINI_SEAT].map(member => `.member-${CSS.escape(member.id)}{--m:${member.color}}`).join('\n');
  return <style>{css}</style>;
}

export type Mood = 'working' | 'waiting' | 'resting' | 'offline' | 'away';

/** The member's state in the room, derived only from real runs, approvals and probe results. */
export function moodOf(info: ProviderInfo | undefined, runs: Run[], waitingOnUser: boolean, ready: boolean): Mood {
  if (waitingOnUser) return 'waiting';
  if (runs.some(run => ['running', 'stopping', 'queued'].includes(run.status) && !run.completedAt)) return 'working';
  if (!info) return 'away';
  return ready ? 'resting' : 'offline';
}
export const MOOD_TEXT: Record<Mood, string> = { working: '正在工作', waiting: '在等你回应', resting: '空闲中', offline: '还没准备好', away: '尚未检查' };

function Initial({ member }: { member: TeamMember }) {
  return <span className="avatar-initial">{[...member.name.trim()][0] ?? '?'}</span>;
}

/** Uploaded images can change shape; never reuse a previous image's measured aspect (height / width). */
function useImageAspect(src: string | undefined, known?: number, fallback = 1.6) {
  const [loaded, setLoaded] = useState<{ src?: string; aspect: number }>();
  const aspect = known ?? (loaded?.src === src ? loaded?.aspect : undefined) ?? fallback;
  function onLoad(event: SyntheticEvent<HTMLImageElement>) {
    const image = event.currentTarget;
    if (!known && image.naturalWidth) setLoaded({ src, aspect: image.naturalHeight / image.naturalWidth });
  }
  return { aspect, onLoad };
}

/** Face avatar: an uploaded avatar as-is, else a crop of the portrait, else the member's initial. */
export function Avatar({ id, member: given, size = 36, mood, ring = true, className = '' }: { id?: string; member?: TeamMember; size?: number; mood?: Mood; ring?: boolean; className?: string }) {
  const team = useTeam();
  const member = given ?? team.get(id) ?? displayFallback(id);
  const framed = member.avatarImage ? member.avatarFace : member.face;
  const { aspect, onLoad } = useImageAspect(member.avatarImage ?? member.art, member.avatarImage ? undefined : member.aspect, member.avatarImage ? 1 : 1.6);
  const style = { '--size': `${size}px`, ...(framed ? { '--fx': framed.x, '--fy': framed.y, '--zoom': framed.zoom } : {}), '--aspect': aspect } as CSSProperties;
  return <span className={`avatar member-${member.id} ${ring ? 'ringed' : ''} ${mood ? `mood-${mood}` : ''} ${className}`} style={style} aria-hidden="true">
    <span className="avatar-face">
      {member.avatarImage ? <img className={framed ? 'uploaded' : 'avatar-cover'} src={member.avatarImage} alt="" draggable={false} onLoad={onLoad} />
        : member.art ? <img className={member.card.portrait ? 'uploaded' : undefined} src={member.art} alt="" draggable={false} onLoad={onLoad} />
        : <Initial member={member} />}
    </span>
    {mood && <span className="avatar-status" />}
  </span>;
}

/** Full-body artwork on a paper card; the white background multiplies into the card tint. */
export function Portrait({ id, member: given, className = '' }: { id?: string; member?: TeamMember; className?: string }) {
  const team = useTeam();
  const member = given ?? team.get(id) ?? displayFallback(id);
  const { aspect, onLoad } = useImageAspect(member.art, member.aspect);
  const offset = member.card.portraitOffset;
  const adjusted = member.card.portraitScale !== undefined || offset !== undefined;
  const style = { '--portrait-scale': member.card.portraitScale ?? PORTRAIT_SCALE.default, '--portrait-aspect': aspect, '--px': offset?.x ?? 0, '--py': offset?.y ?? 0 } as CSSProperties;
  return <span className={`portrait member-${member.id} ${member.art ? '' : 'empty'} ${member.card.portrait ? 'uploaded' : ''} ${adjusted ? 'adjusted' : ''} ${className}`} style={style} aria-hidden="true">
    {member.art ? <img src={member.art} alt="" draggable={false} onLoad={onLoad} /> : <span className="portrait-initial">{[...member.name.trim()][0] ?? '?'}</span>}
  </span>;
}

/** The user's own avatar: an uploaded picture, else the first character of their name. */
export function UserAvatar({ name, avatar, size = 30 }: { name: string; avatar?: string; size?: number }) {
  return <span className="avatar user-avatar" style={{ '--size': `${size}px` } as CSSProperties} aria-hidden="true">
    <span className="avatar-face">{avatar ? <img className="avatar-cover" src={assetUrl(avatar)} alt="" draggable={false} /> : <span className="avatar-initial">{[...name.trim()][0] ?? '我'}</span>}</span>
  </span>;
}
