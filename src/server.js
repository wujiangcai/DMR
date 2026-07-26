"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const PUBLIC = path.join(ROOT, "public");
const ROUTES = new Map([
  ["/core.js", path.join(ROOT, "src", "plr", "core.js")],
  ["/fixtures/DAT0131.PLR", path.join(ROOT, "fixtures", "DAT0131.PLR")],
  ["/fixtures/curve.xls", path.join(ROOT, "fixtures", "curve.xls")],
]);
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".png": "image/png", ".svg": "image/svg+xml", ".xls": "application/vnd.ms-excel",
  ".plr": "application/octet-stream",
};

function safePublicPath(urlPath) {
  let clean;
  try {
    clean = decodeURIComponent(urlPath.split("?")[0]);
  } catch (_error) {
    return null; // 畸形百分号编码按 404 处理，不能让异常打死整个服务
  }
  const relative = clean === "/" ? "index.html" : clean.replace(/^\/+/, "");
  const target = path.resolve(PUBLIC, relative);
  return target === PUBLIC || target.startsWith(PUBLIC + path.sep) ? target : null;
}

function sendFile(req, res, file) {
  fs.stat(file, (error, stat) => {
    if (error || !stat.isFile()) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); return res.end("文件不存在"); }
    const headers = {
      "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
      "Content-Length": stat.size,
      "Cache-Control": path.basename(file).includes("xlsx.full.min") ? "public, max-age=86400" : "no-cache",
      "X-Content-Type-Options": "nosniff",
    };
    res.writeHead(200, headers);
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

function createServer() {
  return http.createServer((req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, { Allow: "GET, HEAD" }); return res.end(); }
    const pathname = new URL(req.url, "http://127.0.0.1").pathname;
    if (pathname === "/api/health") {
      const body = JSON.stringify({ ok: true, application: "DMR Curve Studio", version: "0.1.0" });
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) }); return res.end(body);
    }
    const explicit = ROUTES.get(pathname);
    return sendFile(req, res, explicit || safePublicPath(pathname) || "");
  });
}

if (require.main === module) {
  const host = process.env.DMR_HOST || "127.0.0.1";
  const port = Number(process.env.DMR_PORT || 17378);
  const server = createServer();
  server.listen(port, host, () => {
    console.log(`DMR Curve Studio 已启动：http://${host}:${port}`);
    console.log("按 Ctrl+C 停止服务");
  });
}

module.exports = { createServer };

