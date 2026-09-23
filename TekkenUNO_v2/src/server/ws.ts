// 依存ライブラリなしの小さな WebSocket サーバー実装（RFC 6455 のテキスト通信に必要な部分だけ）
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_MESSAGE = 16 * 1024; // 受信するメッセージの上限
const MAX_BUFFERED = 2 * 1024 * 1024; // 送信が詰まった相手は切る

export interface WsHandlers {
  onMessage: (text: string) => void;
  onClose: () => void;
}

export class WsConn {
  private buf: Buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragOpcode = 0;
  private fragSize = 0;
  closed = false;
  lastSeen = Date.now();
  handlers: WsHandlers = { onMessage: () => {}, onClose: () => {} };

  constructor(
    private socket: Duplex,
    readonly remote: string,
  ) {
    socket.on("data", (d: Buffer) => this.feed(d));
    socket.on("close", () => this.finish());
    socket.on("end", () => this.finish());
    socket.on("error", () => this.finish());
  }

  send(text: string) {
    this.sendFrame(0x1, Buffer.from(text, "utf8"));
  }

  ping() {
    this.sendFrame(0x9, Buffer.alloc(0));
  }

  close(code = 1000) {
    if (this.closed) return;
    const p = Buffer.alloc(2);
    p.writeUInt16BE(code, 0);
    this.sendFrame(0x8, p);
    this.socket.end();
    setTimeout(() => this.socket.destroy(), 2000).unref();
    this.finish();
  }

  terminate() {
    this.socket.destroy();
    this.finish();
  }

  /** 受信データを溜めてフレームに分解する */
  feed(chunk: Buffer) {
    if (this.closed) return;
    this.lastSeen = Date.now();
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        if (this.buf.readUInt32BE(2) !== 0) return this.close(1009);
        len = this.buf.readUInt32BE(6);
        off = 10;
      }
      if (len > MAX_MESSAGE) return this.close(1009);
      if (!masked) return this.close(1002); // 画面側からのフレームは必ずマスクされる
      if (this.buf.length < off + 4 + len) return;
      const mask = this.buf.subarray(off, off + 4);
      const payload = Buffer.allocUnsafe(len);
      const src = this.buf.subarray(off + 4, off + 4 + len);
      for (let i = 0; i < len; i++) payload[i] = src[i] ^ mask[i & 3];
      this.buf = this.buf.subarray(off + 4 + len);
      this.onFrame(fin, opcode, payload);
      if (this.closed) return;
    }
  }

  private onFrame(fin: boolean, opcode: number, payload: Buffer) {
    switch (opcode) {
      case 0x0: {
        if (!this.fragOpcode) return this.close(1002);
        this.fragSize += payload.length;
        if (this.fragSize > MAX_MESSAGE) return this.close(1009);
        this.fragments.push(payload);
        if (fin) {
          const whole = Buffer.concat(this.fragments);
          const op = this.fragOpcode;
          this.fragments = [];
          this.fragOpcode = 0;
          this.fragSize = 0;
          if (op === 0x1) this.handlers.onMessage(whole.toString("utf8"));
        }
        return;
      }
      case 0x1:
      case 0x2:
        if (this.fragOpcode) return this.close(1002);
        if (!fin) {
          this.fragOpcode = opcode;
          this.fragments = [payload];
          this.fragSize = payload.length;
          return;
        }
        if (opcode === 0x1) this.handlers.onMessage(payload.toString("utf8"));
        return;
      case 0x8:
        this.sendFrame(0x8, payload.subarray(0, 2));
        this.socket.end();
        this.finish();
        return;
      case 0x9:
        this.sendFrame(0xa, payload);
        return;
      case 0xa:
        return;
      default:
        this.close(1002);
    }
  }

  private sendFrame(opcode: number, payload: Buffer) {
    if (this.closed || this.socket.destroyed) return;
    if (this.socket.writableLength > MAX_BUFFERED) {
      this.terminate();
      return;
    }
    const len = payload.length;
    let header: Buffer;
    if (len < 126) {
      header = Buffer.from([0x80 | opcode, len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeUInt32BE(0, 2);
      header.writeUInt32BE(len, 6);
    }
    this.socket.write(Buffer.concat([header, payload]));
  }

  private finish() {
    if (this.closed) return;
    this.closed = true;
    this.handlers.onClose();
  }
}

/** HTTP の upgrade 要求を受けて WebSocket 接続を確立する */
export function acceptUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): WsConn | null {
  const key = req.headers["sec-websocket-key"];
  const upgrade = String(req.headers.upgrade ?? "").toLowerCase();
  if (upgrade !== "websocket" || typeof key !== "string" || req.headers["sec-websocket-version"] !== "13") {
    socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return null;
  }
  const accept = createHash("sha1").update(key + GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  const s = socket as Duplex & { setNoDelay?: (v: boolean) => void };
  s.setNoDelay?.(true);
  const fwd = req.headers["x-forwarded-for"];
  const remote = (typeof fwd === "string" ? fwd.split(",")[0].trim() : "") || req.socket.remoteAddress || "?";
  const conn = new WsConn(socket, remote);
  if (head.length) queueMicrotask(() => conn.feed(head));
  return conn;
}
