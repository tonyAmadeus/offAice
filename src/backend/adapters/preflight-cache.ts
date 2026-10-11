/** Small positive-only cache; explicit checks always refresh, errors never become cached readiness. */
export class PreflightCache<T> {
  private values = new Map<string, { value: T; expires: number }>();
  private pending = new Map<string, Promise<T>>();
  private generation = 0;
  constructor(private ttlMs = 5 * 60 * 1000, private accept: (value: T) => boolean = () => true) {}
  clear() { this.generation++; this.values.clear(); this.pending.clear(); }
  async get(key: string, read: () => Promise<T>, fresh = false): Promise<T> {
    if (fresh) this.values.delete(key);
    if (!fresh) {
      const known = this.values.get(key); if (known && known.expires > Date.now()) return known.value;
      const running = this.pending.get(key); if (running) return running;
    }
    const generation = this.generation;
    const task = read().then(value => {
      if (generation === this.generation && this.pending.get(key) === task) {
        this.values.delete(key);
        if (this.accept(value)) { this.values.set(key, { value, expires: Date.now() + this.ttlMs }); if (this.values.size > 32) this.values.delete(this.values.keys().next().value!); }
      }
      return value;
    }).finally(() => { if (this.pending.get(key) === task) this.pending.delete(key); });
    this.pending.set(key, task);
    return task;
  }
}
