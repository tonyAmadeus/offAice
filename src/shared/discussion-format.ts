/** Envelope parsing is separate from discussion authority. Prose never supplies control decisions. */
export class DiscussionFormatError extends Error {
  constructor(message: string, readonly retryable = false) { super(message); this.name = 'DiscussionFormatError'; }
}

function objects(text: string) {
  const spans: { start: number; end?: number }[] = [];
  let depth = 0, quoted = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (!depth) { if (c === '{') { spans.push({ start: i }); depth = 1; } continue; }
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === '{') depth++;
    else if (c === '}' && !--depth) spans.at(-1)!.end = i + 1;
  }
  return spans;
}

function stringEnd(text: string, start: number): number | undefined {
  let escaped = false;
  for (let i = start + 1; i < text.length; i++) {
    if (escaped) escaped = false;
    else if (text[i] === '\\') escaped = true;
    else if (text[i] === '"') return i + 1;
  }
}

/** Only top-level fields count, including when the last JSON string is still arriving. */
function fields(raw: string, partial = false) {
  const found = new Map<string, { raw: string; complete: boolean }>();
  let i = 1;
  const whitespace = () => { while (/\s/.test(raw[i] ?? '') && i < raw.length) i++; };
  while (i < raw.length) {
    whitespace(); if (raw[i] === '}') return found;
    if (raw[i] !== '"') return;
    const keyEnd = stringEnd(raw, i); if (keyEnd === undefined) return found;
    let key: string; try { key = JSON.parse(raw.slice(i, keyEnd)); } catch { return; }
    if (found.has(key)) return;
    i = keyEnd; whitespace();
    if (partial && i === raw.length) return found;
    if (raw[i++] !== ':') return;
    whitespace(); const start = i;
    let end: number | undefined, complete = true;
    if (raw[i] === '"') { end = stringEnd(raw, i); if (end === undefined) { end = raw.length; complete = false; } }
    else {
      let depth = 0, quoted = false, escaped = false;
      for (; i < raw.length; i++) {
        const c = raw[i];
        if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; }
        else if (c === '"') quoted = true;
        else if (c === '[' || c === '{') depth++;
        else if (c === ']' || c === '}') { if (!depth) { end = i; break; } depth--; }
        else if (c === ',' && !depth) { end = i; break; }
      }
      if (end === undefined) { end = raw.length; complete = false; }
    }
    found.set(key, { raw: raw.slice(start, end), complete }); i = end;
    if (!complete) return found;
    whitespace(); if (raw[i] === '}' || partial && i === raw.length) return found;
    if (raw[i++] !== ',') return;
  }
  return found;
}

export function discussionObject(text: string): Record<string, any> {
  try { const value = JSON.parse(text.trim()); if (!value || Array.isArray(value) || typeof value !== 'object') throw new DiscussionFormatError('讨论回复必须是 JSON 对象。', true); }
  catch (error) { if (error instanceof DiscussionFormatError) throw error; }
  const spans = objects(text);
  if (spans.length > 1) throw new DiscussionFormatError('讨论回复包含多个对象，无法核对唯一轮次。');
  if (spans.length !== 1 || spans[0].end === undefined) throw new DiscussionFormatError('成员没有返回唯一、完整的讨论 JSON 对象。', true);
  const raw = text.slice(spans[0].start, spans[0].end);
  let value: any; try { value = JSON.parse(raw); } catch { throw new DiscussionFormatError('讨论 JSON 格式无效。', true); }
  // Duplicate metadata can hide a different turn or proposal; never repair or infer its authority.
  if (!fields(raw)) throw new DiscussionFormatError('讨论 JSON 包含重复或不明确的字段。');
  return value;
}

function partialString(raw: string, complete: boolean): string | undefined {
  if (!raw.startsWith('"')) return;
  if (complete) { try { const value = JSON.parse(raw); return typeof value === 'string' ? value : undefined; } catch { return; } }
  const escapes: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
  let body = '';
  for (let i = 1; i < raw.length; i++) {
    const c = raw[i];
    if (c.charCodeAt(0) < 32 || c === '"') return;
    if (c !== '\\') { body += c; continue; }
    if (++i >= raw.length) break;
    if (raw[i] === 'u') {
      if (i + 4 >= raw.length) break;
      const hex = raw.slice(i + 1, i + 5); if (!/^[\da-f]{4}$/i.test(hex)) return;
      body += String.fromCharCode(parseInt(hex, 16)); i += 4;
    } else { if (!(raw[i] in escapes)) return; body += escapes[raw[i]]; }
  }
  // Do not render half of a split UTF-16 surrogate pair.
  return /[\uD800-\uDBFF]$/.test(body) ? body.slice(0, -1) : body;
}

/** A provisional display only. The backend still validates the complete reply before applying it. */
export function streamDiscussionBody(text: string, turn?: string, revision?: number): string {
  if (!turn || revision === undefined) return '';
  const spans = objects(text); if (spans.length !== 1) return '';
  const values = fields(text.slice(spans[0].start, spans[0].end), true); if (!values) return '';
  const read = (key: string) => { const v = values.get(key); if (!v?.complete) return; try { return JSON.parse(v.raw); } catch { return; } };
  if (read('version') !== 1 || read('turn') !== turn || read('revision') !== revision || !['speak','propose','reject','ask_user'].includes(read('action'))) return '';
  const body = values.get('body'); if (!body) return '';
  const decoded = partialString(body.raw, body.complete);
  return decoded !== undefined && decoded.length <= 12000 ? decoded : '';
}
