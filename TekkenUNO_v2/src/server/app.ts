// HTTP（画面ファイルの配信）と WebSocket（ゲーム通信）のサーバー本体
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants as zc, gzipSync } from "node:zlib";
import { type Client, Lobby } from "./rooms.js";
import { type WsConn, acceptUpgrade } from "./ws.js";

declare const __BUILD_ID__: string | undefined;
export const BUILD = typeof __BUILD_ID__ === "string" ? __BUILD_ID__ : "dev";

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CLIENT_DIR = existsSync(path.join(here, "client")) ? path.join(here, "client") : path.resolve(here, "../../dist/client");

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
};
const COMPRESSIBLE = new Set([".html", ".js", ".css", ".svg", ".json", ".webmanifest", ".txt"]);
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
  "connect-src 'self' ws: wss:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

interface CachedFile {
  type: string;
  raw: Buffer;
  br?: Buffer;
  gz?: Buffer;
  etag: string;
  immutable: boolean;
}

/** 画面ファイルを読み、圧縮済みのものを覚えておく（開発時は毎回読み直す） */
function fileLoader(clientDir: string) {
  const cache = new Map<string, CachedFile | null>();
  const useCache = BUILD !== "dev";
  return async (rel: string): Promise<CachedFile | null> => {
    if (cache.has(rel)) return cache.get(rel)!;
    const abs = path.resolve(clientDir, "." + rel);
    if (!abs.startsWith(clientDir + path.sep)) return null;
    let raw: Buffer;
    try {
      raw = await readFile(abs);
    } catch {
      if (useCache) cache.set(rel, null);
      return null;
    }
    const ext = path.extname(abs).toLowerCase();
    const f: CachedFile = {
      type: TYPES[ext] ?? "application/octet-stream",
      raw,
      etag: `"${BUILD}-${raw.length}-${rel.length}"`,
      immutable: useCache && rel.startsWith("/assets/"),
    };
    if (COMPRESSIBLE.has(ext) && raw.length > 512) {
      f.br = brotliCompressSync(raw, { params: { [zc.BROTLI_PARAM_QUALITY]: 11 } });
      f.gz = gzipSync(raw, { level: 9 });
    }
    if (useCache) cache.set(rel, f);
    return f;
  };
}

export interface ServerOptions {
  port: number;
  clientDir?: string;
  lobby?: Lobby;
}

export function startServer(opts: ServerOptions) {
  const getFile = fileLoader(opts.clientDir ?? DEFAULT_CLIENT_DIR);
  const lobby = opts.lobby ?? new Lobby({ build: BUILD });
  const conns = new Set<WsConn>();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/healthz") {
        res.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
        res.end("ok");
        return;
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405);
        res.end();
        return;
      }
      let rel = decodeURIComponent(url.pathname);
      if (rel.endsWith("/")) rel += "index.html";
      let file = await getFile(rel);
      if (!file && !rel.startsWith("/assets/")) file = await getFile("/index.html");
      if (!file) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
        return;
      }
      const headers: Record<string, string> = {
        "content-type": file.type,
        "cache-control": file.immutable ? "public, max-age=31536000, immutable" : "no-cache",
        etag: file.etag,
        vary: "accept-encoding",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      };
      if (file.type.startsWith("text/html")) headers["content-security-policy"] = CSP;
      if (req.headers["if-none-match"] === file.etag) {
        res.writeHead(304, headers);
        res.end();
        return;
      }
      const ae = String(req.headers["accept-encoding"] ?? "");
      let body = file.raw;
      if (file.br && /\bbr\b/.test(ae)) {
        body = file.br;
        headers["content-encoding"] = "br";
      } else if (file.gz && /\bgzip\b/.test(ae)) {
        body = file.gz;
        headers["content-encoding"] = "gzip";
      }
      headers["content-length"] = String(body.length);
      res.writeHead(200, headers);
      res.end(req.method === "HEAD" ? undefined : body);
    } catch {
      res.writeHead(500);
      res.end();
    }
  });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    const conn = acceptUpgrade(req, socket, head);
    if (!conn) return;
    conns.add(conn);
    const client: Client = {
      token: null,
      tokens: 20,
      tokensAt: Date.now(),
      send: (msg) => conn.send(JSON.stringify(msg)),
    };
    conn.handlers = {
      onMessage: (text) => {
        lobby.handle(client, text);
        lobby.flushAll();
      },
      onClose: () => {
        conns.delete(conn);
        lobby.disconnect(client);
        lobby.flushAll();
      },
    };
  });

  // 死んだ接続（スマホのスリープなど）を見つけて切る
  const heartbeat = setInterval(() => {
    const t = Date.now();
    for (const c of conns) {
      if (c.closed) conns.delete(c);
      else if (t - c.lastSeen > 45_000) c.terminate();
      else c.ping();
    }
  }, 15_000);
  heartbeat.unref();

  const ticker = setInterval(() => lobby.tick(), 200);

  const ready = new Promise<number>((resolve) => {
    server.listen(opts.port, "0.0.0.0", () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : opts.port);
    });
  });

  function close() {
    clearInterval(heartbeat);
    clearInterval(ticker);
    for (const c of conns) c.close(1001);
    return new Promise<void>((resolve) => server.close(() => resolve()));
  }

  return { server, lobby, ready, close };
}
