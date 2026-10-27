import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";

export const dynamic = "force-dynamic";

/** Proof media for THE FEED. Byte ranges, because Safari won't play a video without them. */
const MEDIA = path.join(process.cwd(), "data", "x", "media");
const TYPES: Record<string, string> = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
  ".gif": "image/gif", ".mp4": "video/mp4", ".mov": "video/quicktime",
};

export async function GET(req: NextRequest, ctx: { params: Promise<{ name: string }> }) {
  const { name } = await ctx.params;
  // Names only — no separators, no dot-dot — so nothing outside data/x/media is reachable.
  if (!/^[\w][\w.-]*$/.test(name) || name.includes("..")) return new NextResponse("bad name", { status: 400 });
  const type = TYPES[path.extname(name).toLowerCase()];
  const file = path.join(MEDIA, name);
  if (!type || !fs.existsSync(file)) return new NextResponse("not found", { status: 404 });
  const size = fs.statSync(file).size;
  const range = req.headers.get("range")?.match(/bytes=(\d*)-(\d*)/);
  if (range) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size || start > end) {
      return new NextResponse(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    }
    const stream = fs.createReadStream(file, { start, end });
    return new NextResponse(stream as unknown as ReadableStream, {
      status: 206,
      headers: {
        "Content-Type": type, "Content-Length": String(end - start + 1),
        "Content-Range": `bytes ${start}-${end}/${size}`, "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=300",
      },
    });
  }
  const stream = fs.createReadStream(file);
  return new NextResponse(stream as unknown as ReadableStream, {
    headers: { "Content-Type": type, "Content-Length": String(size), "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=300" },
  });
}
