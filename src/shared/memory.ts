import type { MemberProfile, MemoryEntry } from './types';

/** What the member is sent each turn, in characters, across all entries that are on. */
export const MEMORY_TEXT_LIMIT = 8000;
export const MEMORY_ENTRY_LIMIT = 2000;
export const MEMORY_ENTRIES_MAX = 200;
export const MEMORY_SOURCES: Record<MemoryEntry['source'], string> = { manual: '手写', imported: '导入', proposed: '成员提议' };

export const newMemoryId = () => `mem-${globalThis.crypto.randomUUID().slice(0, 8)}`;

/** A card's memories as entries. Cards saved before entries existed keep their text as one handwritten entry. */
export function memoryEntries(card: Pick<MemberProfile, 'memory' | 'memories' | 'createdAt'>): MemoryEntry[] {
  if (card.memories) return card.memories;
  const text = card.memory?.trim();
  return text ? [{ id: 'memory-legacy', text, source: 'manual', createdAt: card.createdAt ?? new Date(0).toISOString() }] : [];
}
/** The entries that are on, as the text members receive. */
export const activeMemoryText = (entries: MemoryEntry[]) => entries.filter(entry => !entry.off).map(entry => entry.text).join('\n');

const isoDate = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined;

/** Accept entries from the renderer, or convert a legacy text. Oversized input is refused rather than cut. */
export function normalizeMemories(value: unknown, legacy: unknown, createdAt: string): MemoryEntry[] | undefined {
  if (!Array.isArray(value)) {
    const text = typeof legacy === 'string' ? legacy.trim().slice(0, MEMORY_TEXT_LIMIT) : '';
    return text ? [{ id: 'memory-legacy', text, source: 'manual', createdAt }] : undefined;
  }
  if (value.length > MEMORY_ENTRIES_MAX) throw new Error(`长期记忆最多 ${MEMORY_ENTRIES_MAX} 条`);
  const seen = new Set<string>(), result: MemoryEntry[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const text = typeof item.text === 'string' ? item.text.trim() : '';
    if (!text) continue;
    if (text.length > MEMORY_ENTRY_LIMIT) throw new Error(`每条长期记忆最多 ${MEMORY_ENTRY_LIMIT} 字`);
    const id = typeof item.id === 'string' && /^[\w-]{1,64}$/.test(item.id) && !seen.has(item.id) ? item.id : newMemoryId();
    seen.add(id);
    const origin = typeof item.origin === 'string' ? item.origin.trim().slice(0, 80) : '';
    const updatedAt = isoDate(item.updatedAt);
    result.push({
      id, text, source: item.source === 'imported' || item.source === 'proposed' ? item.source : 'manual',
      ...(origin ? { origin } : {}), createdAt: isoDate(item.createdAt) ?? new Date().toISOString(),
      ...(updatedAt ? { updatedAt } : {}), ...(item.off === true ? { off: true } : {}),
    });
  }
  if (activeMemoryText(result).length > MEMORY_TEXT_LIMIT) throw new Error(`生效的长期记忆合计超过 ${MEMORY_TEXT_LIMIT} 字，请精简或关掉部分条目`);
  return result;
}
