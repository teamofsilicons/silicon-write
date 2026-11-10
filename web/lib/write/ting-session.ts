/** One anonymous Ting receiver per Write page. Account credentials stay in the BFF.
 * The binding capability lives only in memory and expires with this socket.
 * Hints are advisory; every initial bind, renewal and reconnect reconciles state.
 */
export type Change = "meta" | "threads" | "document";
export interface Signal { active: boolean; changes: Change[] }
export interface Binding { session_id: string; binding: string }
interface Config { enabled: boolean; url: string }
type Socket = Pick<WebSocket, "onmessage" | "onclose" | "onerror" | "close">;
export interface Transport {
  config(): Promise<Config>;
  socket(url: string): Socket;
  watch(doc: string, body: Binding & { revision: number; remove?: boolean }): Promise<unknown>;
}
interface Doc { listeners: Set<(signal: Signal) => void>; active: boolean; busy: boolean }
const ALL: Change[] = ["meta", "threads", "document"];

export class NotificationSession {
  private docs = new Map<string, Doc>();
  private socket: Socket | null = null;
  private binding: Binding | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private renewal: ReturnType<typeof setInterval> | null = null;
  private deadline: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private revision = 0;
  private failures = 0;
  private healthyAt = 0;
  private connecting = false;

  constructor(private transport: Transport) {}

  subscribe(docId: string, listener: (signal: Signal) => void): () => void {
    let doc = this.docs.get(docId);
    if (!doc) { doc = { listeners: new Set(), active: false, busy: false }; this.docs.set(docId, doc); }
    doc.listeners.add(listener);
    if (doc.active) listener({ active: true, changes: ALL });
    if (this.binding) void this.bind(docId, doc, this.generation);
    else void this.connect();
    return () => {
      doc.listeners.delete(listener);
      if (!doc.listeners.size) {
        this.docs.delete(docId);
        if (this.binding) void this.transport.watch(docId, { ...this.binding, revision: ++this.revision, remove: true }).catch(() => {});
      }
      if (!this.docs.size) this.close();
    };
  }

  close() {
    this.generation++;
    this.connecting = false;
    if (this.retry) clearTimeout(this.retry);
    if (this.renewal) clearInterval(this.renewal);
    if (this.deadline) clearTimeout(this.deadline);
    this.retry = null; this.renewal = null; this.deadline = null;
    const socket = this.socket; this.socket = null; this.binding = null;
    if (socket) { socket.onclose = null; socket.onerror = null; socket.onmessage = null; socket.close(); }
    for (const doc of this.docs.values()) {
      doc.busy = false; doc.active = false;
      for (const listener of doc.listeners) listener({ active: false, changes: [] });
    }
  }

  reconnect() { this.close(); void this.connect(); }

  private failed(generation: number) {
    if (generation !== this.generation) return;
    if (this.healthyAt && Date.now() - this.healthyAt >= 60_000) this.failures = 0;
    this.healthyAt = 0;
    this.close();
    if (!this.docs.size) return;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.failures++, 5));
    this.retry = setTimeout(() => { this.retry = null; void this.connect(); }, Math.min(30_000, delay * (1 + Math.random() * 0.2)));
  }

  private async connect() {
    if (this.connecting || this.socket || this.retry || !this.docs.size) return;
    this.connecting = true;
    const generation = this.generation;
    try {
      const config = await this.transport.config();
      if (generation !== this.generation) return;
      if (!config.enabled) { this.failed(generation); return; }
      const socket = this.transport.socket(config.url);
      this.socket = socket;
      this.deadline = setTimeout(() => this.failed(generation), 15_000);
      socket.onclose = socket.onerror = () => this.failed(generation);
      socket.onmessage = event => {
        if (generation !== this.generation) return;
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        if (message.op === "ready" && typeof message.session_id === "string" && typeof message.binding === "string") {
          if (this.binding) { this.failed(generation); return; }
          this.binding = { session_id: message.session_id, binding: message.binding };
          if (this.deadline) clearTimeout(this.deadline);
          this.deadline = null;
          this.healthyAt = Date.now();
          const renew = () => { for (const [id, doc] of this.docs) void this.bind(id, doc, generation); };
          renew();
          this.renewal = setInterval(renew, 20_000);
        } else if (message.op === "tings" || message.op === "silent_digest") {
          if (!this.binding || message.session_id !== this.binding.session_id || !Array.isArray(message.tings)) return;
          for (const ting of message.tings) {
            if (ting.type !== "write.documentChanged" || ting.session_id !== this.binding.session_id) continue;
            const doc = this.docs.get(ting.data?.doc_id);
            const changes = Array.isArray(ting.data?.changes) ? ALL.filter(c => ting.data.changes.includes(c)) : [];
            if (!doc?.active || !changes.length) continue;
            for (const listener of doc.listeners) listener({ active: true, changes });
          }
        }
      };
    } catch { this.failed(generation); }
    finally { if (generation === this.generation) this.connecting = false; }
  }

  private async bind(id: string, doc: Doc, generation: number) {
    if (!this.binding || doc.busy) return;
    doc.busy = true;
    try {
      await this.transport.watch(id, { ...this.binding, revision: ++this.revision });
      if (generation !== this.generation || this.docs.get(id) !== doc) return;
      doc.active = true;
      for (const listener of doc.listeners) listener({ active: true, changes: ALL });
    } catch (error) {
      if (generation !== this.generation || this.docs.get(id) !== doc) return;
      doc.active = false;
      for (const listener of doc.listeners) listener({ active: false, changes: ALL });
      // The session may have vanished during a service restart. A fresh socket
      // creates a fresh capability and rechecks every document independently.
      if (typeof error === "object" && error && "status" in error && error.status === 409) this.failed(generation);
    } finally { if (generation === this.generation) doc.busy = false; }
  }
}
