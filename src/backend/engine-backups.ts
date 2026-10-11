import type { BackupReason } from "../shared/backup";
import { BackupRestorer } from "./backup-restore";
import { writeBackup } from "./backup-writer";
/** Serializes backups while the engine owns the maintenance lifecycle. */
export class EngineBackups {
  private writing = false;
  constructor(
    private dataDirectory: string,
    private backupWriter: typeof writeBackup,
    private host: { maintenance(): boolean; begin(): void; end(): void },
  ) {}
  async create(reason: BackupReason) {
    if (this.writing) throw new Error("另一个备份正在写入，请稍后再试。");
    const began = !this.host.maintenance();
    if (began) this.host.begin();
    this.writing = true;
    try {
      const backups = new BackupRestorer(this.dataDirectory),
        previous = new Set((await backups.list()).map((item) => item.id));
      await this.backupWriter(this.dataDirectory, reason);
      const created = (await backups.list()).filter(
        (item) => !previous.has(item.id) && item.manifest?.reason === reason,
      );
      if (created.length !== 1)
        throw new Error(
          "备份写入结果尚未核对，未自动再次备份。请刷新备份列表。",
        );
      await backups.preview(created[0].id);
      return created[0];
    } finally {
      this.writing = false;
      if (began) this.host.end();
    }
  }
}
