/** Only read-only state requests wait for a starting worker; mutations are never queued. */
export class BackendReadiness {
  private generation = 0;
  private state: 'starting' | 'ready' | 'stopped' = 'stopped';
  private error = '执行服务尚未启动，请重启后端。';
  private waiters = new Set<{ resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();

  private settle(error?: string) {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      error ? waiter.reject(new Error(error)) : waiter.resolve();
    }
    this.waiters.clear();
  }
  start() {
    this.settle('执行服务正在重新启动，本次状态读取已取消。');
    this.generation++;
    this.state = 'starting';
    return this.generation;
  }
  current(generation: number) { return generation === this.generation; }
  assertReady(generation: number) {
    if (!this.current(generation)) throw new Error('执行服务已切换，本次请求已取消。');
    if (this.state !== 'ready') throw new Error(this.state === 'starting' ? '执行服务尚未就绪，请稍候或重新打开应用' : this.error);
  }
  markReady(generation: number) {
    if (!this.current(generation) || this.state !== 'starting') return false;
    this.state = 'ready';
    this.settle();
    return true;
  }
  fail(generation: number, message: string) {
    if (!this.current(generation)) return false;
    this.state = 'stopped';
    this.error = message;
    this.settle(message);
    return true;
  }
  wait(generation: number, timeout: number): Promise<void> {
    if (!this.current(generation)) return Promise.reject(new Error('执行服务已切换，本次状态读取已取消。'));
    if (this.state === 'ready') return Promise.resolve();
    if (this.state !== 'starting') return Promise.reject(new Error(this.error));
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error('执行服务启动超时，请查看后台状态或重启后端。'));
      }, timeout) };
      this.waiters.add(waiter);
    });
  }
}
