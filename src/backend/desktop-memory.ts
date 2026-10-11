import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

/** A place on this computer where a desktop client keeps memory AIROOM can offer to import. */
export interface MemorySource { id: string; label: string; count?: number }
/** One importable item; the user picks which ones become entries on a card. */
export interface MemoryCandidate { text: string; origin: string }

const TEXT_MAX = 2000, FILE_MAX = 256 * 1024;
const home = () => process.env.USERPROFILE || process.env.HOME || '';
const cap = (text: string) => text.length > TEXT_MAX ? `${text.slice(0, TEXT_MAX - 1)}…` : text;
async function isFile(file: string) { try { return (await stat(file)).isFile(); } catch { return false; } }
async function readText(file: string) {
  const info = await stat(file);
  if (!info.isFile() || info.size > FILE_MAX) throw new Error('记忆文件太大或无法读取');
  return readFile(file, 'utf8');
}
const codexSummary = (root: string) => path.join(root, '.codex', 'memories', 'memory_summary.md');
const claudeProjects = (root: string) => path.join(root, '.claude', 'projects');
async function claudeMemoryFiles(project: string) {
  try { return (await readdir(path.join(project, 'memory'))).filter(name => /\.md$/i.test(name) && name.toUpperCase() !== 'MEMORY.MD').sort(); } catch { return []; }
}
/** "C--Users-admin-Desktop-x" back to a readable path; only a label, never used to open anything. */
const projectLabel = (name: string) => name.replace(/^([A-Za-z])--/, '$1:\\').replace(/-/g, '\\');

/** Only the memory locations below are ever read; credential and session files are not. */
export async function memorySources(executor: string, root = home()): Promise<MemorySource[]> {
  if (executor === 'codex') return await isFile(codexSummary(root)) ? [{ id: 'codex-summary', label: 'Codex 记忆摘要：用户画像和偏好' }] : [];
  if (executor === 'claude') {
    let names: string[] = [];
    try { names = await readdir(claudeProjects(root)); } catch { return []; }
    const sources: MemorySource[] = [];
    for (const name of names.sort()) {
      const files = await claudeMemoryFiles(path.join(claudeProjects(root), name));
      if (files.length) sources.push({ id: `claude:${name}`, label: `Claude 项目记忆：${projectLabel(name)}`, count: files.length });
    }
    return sources;
  }
  return [];
}

export async function memoryCandidates(executor: string, source: string, root = home()): Promise<MemoryCandidate[]> {
  if (executor === 'codex' && source === 'codex-summary') return codexCandidates(await readText(codexSummary(root)));
  if (executor === 'claude' && source.startsWith('claude:')) {
    // The project must be one listed in the projects folder: no separators, no parent references.
    const name = source.slice('claude:'.length);
    let names: string[] = [];
    try { names = await readdir(claudeProjects(root)); } catch {}
    if (!names.includes(name) || /[\\/]/.test(name) || name === '.' || name === '..') throw new Error('没有找到这个 Claude 项目的记忆');
    const project = path.join(claudeProjects(root), name), candidates: MemoryCandidate[] = [];
    for (const file of await claudeMemoryFiles(project)) {
      const candidate = claudeCandidate(await readText(path.join(project, 'memory', file)), file);
      if (candidate) candidates.push(candidate);
    }
    return candidates;
  }
  throw new Error('这位成员没有可以导入的桌面端记忆');
}

/** Codex's summary: only the sections about the user (profile, preferences); each bullet or paragraph is one item. */
export function codexCandidates(text: string): MemoryCandidate[] {
  const candidates: MemoryCandidate[] = [];
  for (const section of text.replace(/\r\n?/g, '\n').split(/^(?=#{1,3}\s)/m)) {
    const [heading, ...rest] = section.split('\n');
    if (!/^#{1,3}\s/.test(heading) || !/user profile|user preferences|用户画像|偏好/i.test(heading)) continue;
    const label = heading.replace(/^#+\s*/, '').trim(), body = rest.join('\n').trim();
    const bullets = body.split('\n').filter(line => /^\s*[-*]\s+/.test(line)).map(line => line.replace(/^\s*[-*]\s+/, '').trim()).filter(Boolean);
    const items = bullets.length ? bullets : body.split(/\n\s*\n/).map(part => part.replace(/\s+/g, ' ').trim()).filter(Boolean);
    for (const item of items) candidates.push({ text: cap(item), origin: `Codex 记忆 · ${label}` });
  }
  return candidates;
}
/** A Claude memory file: front matter gives its name; the body is the fact. */
export function claudeCandidate(raw: string, file: string): MemoryCandidate | undefined {
  const text = raw.replace(/\r\n?/g, '\n'), front = text.match(/^---\n([\s\S]*?)\n---\n?/);
  let name = file.replace(/\.md$/i, ''), body = text;
  if (front) { body = text.slice(front[0].length); const named = front[1].match(/^name:\s*(.+)$/m); if (named) name = named[1].trim().replace(/^["']|["']$/g, ''); }
  const fact = body.replace(/\[\[([^\]]+)\]\]/g, '$1').trim();
  return fact ? { text: cap(fact), origin: `Claude 记忆 · ${name}`.slice(0, 80) } : undefined;
}
