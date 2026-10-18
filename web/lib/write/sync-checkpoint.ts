/** A same-socket sync reply acknowledges exactly the local revision preceding its request. */
interface Pending {
  revision: number;
  promise: Promise<boolean>;
  resolve: (saved: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class SyncCheckpoint {
  private revision = 0;
  private acknowledged = 0;
  private pending: Pending | null = null;
  private refused = false;
  private refusalReason: string | null = null;

  constructor(private readonly options: { ready: () => boolean; send: () => void; onSaved: () => void; timeoutMs?: number }) {}

  changed() { this.revision++; }
  get hasChanges() { return this.acknowledged < this.revision; }
  get rejectionReason() { return this.refusalReason; }
  /** Capture before dispatching a sync reply, because dispatch can start another request. */
  get responseToken(): object | null { return this.pending; }

  flush(): Promise<boolean> {
    if (this.refused) return Promise.resolve(false);
    if (!this.hasChanges) return Promise.resolve(true);
    if (this.pending) return this.pending.promise;
    if (!this.options.ready()) return Promise.resolve(false);
    let resolve!: (saved: boolean) => void;
    const promise = new Promise<boolean>(done => { resolve = done; });
    // Timeout settles the caller but retains the request's place. A late reply must
    // never be consumed as an acknowledgement of newer edits on this socket.
    this.pending = { revision: this.revision, promise, resolve, timer: setTimeout(() => resolve(false), this.options.timeoutMs ?? 5000) };
    try { this.options.send(); } catch { this.disconnect(); }
    return promise;
  }

  reply(token: object | null): boolean {
    const pending = this.pending;
    if (!pending || token !== pending) return false;
    this.pending = null;
    clearTimeout(pending.timer);
    if (!this.refused) this.acknowledged = Math.max(this.acknowledged, pending.revision);
    pending.resolve(!this.refused);
    if (!this.hasChanges && !this.refused) this.options.onSaved();
    return true;
  }

  reject(reason = "The service refused a change.") { this.refused = true; this.refusalReason = reason; this.disconnect(); }
  disconnect() {
    if (!this.pending) return;
    clearTimeout(this.pending.timer);
    this.pending.resolve(false);
    this.pending = null;
  }
}
