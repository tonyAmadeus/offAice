import { promises as fs, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { Store } from './store';
import type { Project } from '../shared/types';
import { FlowError, type Round, type Integration, type Acceptance, type FlowArtifact } from '../shared/project-flow';
import type { ResultPreview, RoundResults } from '../shared/round-results';
import { OPENABLE_DOCUMENT } from '../shared/round-results';
import { FlowArtifacts } from './project-flow-artifacts';
import type { ApplyJournal } from './project-flow-apply';
import { scopePath, text } from '../shared/project-flow-protocol';
import { readArtifact, workspaceFingerprint } from './workspace';
import { redact, resolveSafePath } from './security';

async function digest(file: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
/** Read-only result projection. Accepted history and the mutable project directory are distinct. */
export class RoundResultReader {
  private artifacts: FlowArtifacts;
  constructor(private store: Store) { this.artifacts = new FlowArtifacts(store); }
  private context(p: Record<string, unknown>) {
    const project = this.store.get<Project>('projects', text(p.projectId));
    const round = this.store.get<Round>('flow_rounds', text(p.roundId));
    if (!project || !round || round.projectId !== project.id) throw new FlowError('NOT_FOUND', '轮次不属于这个项目。');
    const id = p.integrationId === undefined ? round.integrationId : text(p.integrationId);
    const integration = id ? this.store.get<Integration>('flow_integrations', id) : undefined;
    if (id && (!integration || integration.roundId !== round.id || integration.projectId !== project.id || integration.flowId !== round.flowId)) throw new FlowError('NOT_FOUND', '成果不属于这个轮次。');
    const acceptance = this.store.list<Acceptance>('flow_acceptances').find(a => a.roundId === round.id && a.projectId === project.id && a.integrationId === integration?.id && a.version.artifactId === integration?.version?.artifactId && a.version.fingerprint === integration?.version?.fingerprint && a.status === 'accepted' && a.requiresApply);
    const journal = acceptance?.applyOperationId ? this.store.get<ApplyJournal>('flow_apply_journals', acceptance.applyOperationId) : undefined;
    const applied = Boolean(journal && journal.state === 'applied' && journal.projectId === project.id && journal.acceptanceId === acceptance?.id && journal.artifactId === integration?.version?.artifactId && path.resolve(journal.directory).toLowerCase() === path.resolve(project.directory).toLowerCase());
    return { project, round, integration, applied };
  }
  private async artifact(id: string, projectId: string, flowId: string, expected?: string) {
    const artifact = this.artifacts.get(id);
    if (artifact.transient || artifact.projectId !== projectId || artifact.flowId !== flowId) throw new FlowError('NOT_FOUND', '成果版本归属不符。');
    if (expected && artifact.fingerprint !== expected || await workspaceFingerprint(artifact.root) !== artifact.fingerprint) throw new FlowError('STALE_VERSION', '成果副本已变化，不能当作本轮提交的版本。');
    return artifact;
  }
  async results(p: Record<string, unknown>): Promise<RoundResults> {
    const { project, round, integration, applied } = this.context(p);
    const base: RoundResults = { projectId: project.id, roundId: round.id, integrationId: integration?.id, version: integration?.version, applied, availability: 'pending', detail: '本轮还没有可查看的成品。', files: [] };
    if (!integration?.version) return base;
    try {
      const artifact = await this.artifact(integration.version.artifactId, project.id, round.flowId, integration.version.fingerprint);
      const after = await this.artifacts.manifest(artifact.root);
      const before = artifact.baseArtifactId ? await this.artifacts.manifest((await this.artifact(artifact.baseArtifactId, project.id, round.flowId)).root) : {};
      const changes = new Map(this.artifacts.delta(before, after).map(c => [c.path, c.kind]));
      const report = integration.id === round.integrationId ? round.report : integration.reportDraft;
      const declared = new Set((report?.deliverables ?? []).map(s => s.replaceAll('\\', '/')));
      const files = [...new Set([...Object.keys(after), ...changes.keys()])].sort().map(name => ({ path: name, kind: changes.get(name) ?? 'unchanged' as const, deliverable: declared.has(name) }));
      if (await workspaceFingerprint(artifact.root) !== artifact.fingerprint) throw new FlowError('STALE_VERSION', '读取期间成果副本发生变化。');
      return { ...base, availability: 'ready', detail: '本轮提交版本；项目当前文件另行查看。', files };
    } catch (error) {
      const changed = error instanceof FlowError && error.code === 'STALE_VERSION' && /变化/.test(error.message);
      return { ...base, availability: changed ? 'changed' : 'missing', detail: changed ? '成果副本已变化，不能作为原提交版本展示。' : '成果副本不可用；恢复备份不会恢复工作副本。历史记录仍保留，未用当前文件替代。' };
    }
  }
  async preview(p: Record<string, unknown>): Promise<ResultPreview> {
    const { project, round, integration, applied } = this.context(p);
    if (!integration?.version) throw new FlowError('NOT_FOUND', '尚无成果版本。');
    const name = scopePath(text(p.path)), source = p.source ?? 'submitted';
    if (!['submitted', 'current', 'previous'].includes(String(source))) throw new FlowError('INVALID_REQUEST', '请选择本轮版本、旧版或项目当前文件。');
    let artifact: FlowArtifact | undefined;
    if (source !== 'current') {
      artifact = await this.artifact(integration.version.artifactId, project.id, round.flowId, integration.version.fingerprint);
      if (source === 'previous') {
        if (!artifact.baseArtifactId) throw new FlowError('NOT_FOUND', '没有可查看的旧版。');
        artifact = await this.artifact(artifact.baseArtifactId, project.id, round.flowId);
      }
    } else if (!applied) throw new FlowError('NOT_APPLIED', '这一轮尚未确认写入项目，请查看本轮提交版本。');
    const root = artifact?.root ?? project.directory, target = resolveSafePath(root, name), info = await fs.stat(target);
    if (!info.isFile()) throw new FlowError('NOT_FILE', '请选择文件。');
    const before = await digest(target), ext = path.extname(name).toLowerCase();
    const result: ResultPreview = { path: name, source: source as ResultPreview['source'], kind: 'file', size: info.size };
    const mime: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
    if (mime[ext] && info.size <= 8 * 1024 * 1024) {
      const bytes = await fs.readFile(target);
      const valid = ext === '.png' ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : ['.jpg','.jpeg'].includes(ext) ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 : ext === '.gif' ? /^GIF8[79]a/.test(bytes.subarray(0,6).toString()) : bytes.subarray(0,4).toString() === 'RIFF' && bytes.subarray(8,12).toString() === 'WEBP';
      if (valid) { result.kind = 'image'; result.imageUrl = `data:${mime[ext]};base64,${bytes.toString('base64')}`; }
    } else if (/\.(?:txt|md|json|ya?ml|csv|log|[cm]?js|jsx|ts|tsx|py|html?|css|svg|xml|ps1|sh|bat|cmd|toml|ini|sql|rs|go|java|c|h|cpp)$/i.test(name)) {
      const read = await readArtifact(root, name);
      Object.assign(result, read, { kind: 'text', content: redact(read.content) });
    }
    if (await digest(resolveSafePath(root, name)) !== before || artifact && await workspaceFingerprint(artifact.root) !== artifact.fingerprint) throw new FlowError('STALE_VERSION', '读取期间文件发生变化，请重新查看。');
    if (source === 'current') {
      try {
        const submitted = await this.artifact(integration.version.artifactId, project.id, round.flowId, integration.version.fingerprint);
        result.comparison = await digest(resolveSafePath(submitted.root, name)) === before ? 'same' : 'changed';
      } catch { /* Missing historical bytes cannot certify a comparison. */ }
    }
    return result;
  }
  async openPath(p: Record<string, unknown>) {
    const project = this.store.get<Project>('projects', text(p.projectId));
    if (!project) throw new FlowError('NOT_FOUND', '项目不存在。');
    if (p.roundId !== undefined && !this.context(p).applied) throw new FlowError('NOT_APPLIED', '尚未确认写入项目，不能打开项目当前文件。');
    const relativePath = scopePath(text(p.relativePath)), mode = p.mode;
    if (mode !== 'open' && mode !== 'reveal') throw new FlowError('INVALID_REQUEST', '打开方式无效。');
    const root = await fs.realpath(project.directory), target = resolveSafePath(root, relativePath);
    if (!(await fs.stat(target)).isFile()) throw new FlowError('NOT_FILE', '请选择项目内的文件。');
    return { root, relativePath, target, mode: mode === 'open' && OPENABLE_DOCUMENT.test(target) ? 'open' as const : 'reveal' as const };
  }
}
