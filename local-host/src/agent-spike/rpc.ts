/**
 * LSP-style JSON-RPC 2.0 over a Node socket.
 *
 * Bidirectional. Both sides can `call` (outbound request) and `notify`
 * (outbound notification) and register handlers for incoming requests.
 * Wire format: `Content-Length: N\r\n\r\n{N bytes of UTF-8 JSON}`.
 */

import { randomUUID } from "node:crypto";
import { Socket } from "node:net";

export type RpcHandler = (params: any) => Promise<any> | any;

export class RpcError extends Error {
  constructor(public code: number, message: string, public data?: unknown) {
    super(message);
    this.name = "RpcError";
  }
}

interface PendingCall {
  resolve: (value: any) => void;
  reject: (error: unknown) => void;
  timer?: NodeJS.Timeout;
}

export class RpcEndpoint {
  private buf: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private handlers = new Map<string, RpcHandler>();
  private pending = new Map<string, PendingCall>();
  private closed = false;
  private onNotificationFn: ((method: string, params: any) => void) | null = null;
  private closeListeners: Array<() => void> = [];

  constructor(private socket: Socket) {
    socket.on("data", (chunk) => this.onData(chunk));
    socket.on("close", () => this.onClose());
    socket.on("error", (err) => {
      this.onClose();
      // surface errors via close; nothing else to do here
      void err;
    });
  }

  register(method: string, handler: RpcHandler): void {
    this.handlers.set(method, handler);
  }

  onNotification(fn: (method: string, params: any) => void): void {
    this.onNotificationFn = fn;
  }

  onClose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new RpcError(-32000, "peer closed"));
    }
    this.pending.clear();
    for (const fn of this.closeListeners) {
      try {
        fn();
      } catch {
        // ignore — one listener should not break the others
      }
    }
    this.closeListeners = [];
  }

  whenClosed(fn: () => void): void {
    if (this.closed) {
      fn();
      return;
    }
    this.closeListeners.push(fn);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  async call(method: string, params: unknown, timeoutMs = 30_000): Promise<any> {
    if (this.closed) throw new RpcError(-32000, "endpoint closed");
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError(-32001, `call ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    if (this.closed) return;
    this.send({ jsonrpc: "2.0", method, params });
  }

  close(): void {
    if (!this.closed) {
      this.socket.end();
    }
  }

  // --- private ---

  private send(msg: object): void {
    const body = Buffer.from(JSON.stringify(msg), "utf8");
    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii");
    this.socket.write(Buffer.concat([header, body]));
  }

  private onData(chunk: Buffer): void {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    while (true) {
      const headerEnd = this.buf.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const headerStr = this.buf.subarray(0, headerEnd).toString("ascii");
      let length = -1;
      for (const line of headerStr.split("\r\n")) {
        const ix = line.indexOf(":");
        if (ix === -1) continue;
        if (line.slice(0, ix).trim().toLowerCase() === "content-length") {
          length = Number(line.slice(ix + 1).trim());
        }
      }
      if (length < 0 || !Number.isFinite(length)) {
        // malformed; drop everything up through header to try to recover
        this.buf = this.buf.subarray(headerEnd + 4);
        continue;
      }
      const bodyStart = headerEnd + 4;
      if (this.buf.length < bodyStart + length) return;
      const body = this.buf.subarray(bodyStart, bodyStart + length);
      this.buf = this.buf.subarray(bodyStart + length);
      let msg: any;
      try {
        msg = JSON.parse(body.toString("utf8"));
      } catch {
        continue;
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: any): void {
    // response to one of our outbound calls?
    if (
      typeof msg.id === "string" &&
      typeof msg.method === "undefined" &&
      ("result" in msg || "error" in msg)
    ) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (p.timer) clearTimeout(p.timer);
      if (msg.error) {
        p.reject(new RpcError(msg.error.code ?? -32000, msg.error.message ?? "", msg.error.data));
      } else {
        p.resolve(msg.result);
      }
      return;
    }

    const method = msg.method as string | undefined;
    const params = msg.params ?? {};
    const id = msg.id as string | undefined;

    if (!method) return;
    const handler = this.handlers.get(method);

    if (!handler) {
      if (id !== undefined) {
        this.send({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `method not found: ${method}` },
        });
      } else {
        this.onNotificationFn?.(method, params);
      }
      return;
    }

    void Promise.resolve()
      .then(() => handler(params))
      .then(
        (result) => {
          if (id !== undefined) {
            this.send({ jsonrpc: "2.0", id, result: result ?? null });
          }
        },
        (err: unknown) => {
          if (id === undefined) return;
          if (err instanceof RpcError) {
            this.send({
              jsonrpc: "2.0",
              id,
              error: { code: err.code, message: err.message, data: err.data },
            });
          } else {
            const message = err instanceof Error ? err.message : String(err);
            this.send({ jsonrpc: "2.0", id, error: { code: -32000, message } });
          }
        }
      );
  }
}
