#!/usr/bin/env node
// Read-only CORS server for data/x/media on 127.0.0.1, so the x-post lane can pull a video into
// x.com's file input from inside the page when browser_file_upload is refused ("Not allowed").
//   node bin/x-media-serve.mjs [port] [minutes]   (default 4795, 15 minutes, then exits)
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const DATA = process.env.X_DATA_DIR ? path.resolve(process.env.X_DATA_DIR) : path.join(path.dirname(new URL(import.meta.url).pathname), "..", "data", "x");
const ROOT = path.join(DATA, "media");
const PORT = Number(process.argv[2] || 4795);
const TYPES = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif", ".mp4": "video/mp4", ".mov": "video/quicktime" };

http.createServer((req, res) => {
  const cors = {
    "Access-Control-Allow-Origin": "https://x.com",
    "Access-Control-Allow-Private-Network": "true",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "*",
    "Vary": "Origin",
  };
  if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
  const name = decodeURIComponent((req.url || "").split("?")[0].slice(1));
  const type = TYPES[path.extname(name).toLowerCase()];
  const file = path.join(ROOT, name);
  if (req.method !== "GET" || !/^[\w][\w.-]*$/.test(name) || !type || !fs.existsSync(file)) { res.writeHead(404, cors); return res.end("not found"); }
  res.writeHead(200, { ...cors, "Content-Type": type, "Content-Length": fs.statSync(file).size });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, "127.0.0.1", () => console.log(`x-media on http://127.0.0.1:${PORT}`));

setTimeout(() => process.exit(0), Number(process.argv[3] || 15) * 60 * 1000).unref();
