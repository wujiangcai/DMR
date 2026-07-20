"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const RUNTIME = path.join(ROOT, ".runtime");
const PID_FILE = path.join(RUNTIME, "dmr-server.pid");
const INFO_FILE = path.join(RUNTIME, "dmr-server.json");
const HOST = process.env.DMR_HOST || "127.0.0.1";
const PORT = Number(process.env.DMR_PORT || 17378);
const BROWSER_HOST = HOST === "0.0.0.0" || HOST === "::" ? "127.0.0.1" : HOST;

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function probeHealth(timeoutMs = 700) {
  return new Promise(resolve => {
    const request = http.get(`http://${BROWSER_HOST}:${PORT}/api/health`, { timeout: timeoutMs }, response => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { body += chunk; });
      response.on("end", () => {
        try {
          const result = JSON.parse(body);
          resolve(response.statusCode === 200 && result.ok === true && result.application === "DMR Curve Studio");
        } catch (_error) { resolve(false); }
      });
    });
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve(false));
  });
}

function readPid() {
  try {
    const pid = Number(fs.readFileSync(PID_FILE, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch (_error) { return null; }
}

function findListeningPid() {
  if (process.platform !== "win32") return null;
  const result = spawnSync("netstat.exe", ["-ano", "-p", "tcp"], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) return null;
  for (const line of result.stdout.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 5 || fields[0].toUpperCase() !== "TCP" || fields[3].toUpperCase() !== "LISTENING") continue;
    const localPort = Number(fields[1].match(/:(\d+)$/)?.[1]);
    const pid = Number(fields[4]);
    if (localPort === PORT && Number.isInteger(pid) && pid > 0) return pid;
  }
  return null;
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error && error.code === "EPERM"; }
}

function cleanupRuntimeFiles() {
  for (const file of [PID_FILE, INFO_FILE]) {
    try { fs.rmSync(file, { force: true }); } catch (_error) {}
  }
}

async function main() {
  if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error(`DMR_PORT 无效：${process.env.DMR_PORT || ""}`);
  const healthy = await probeHealth();
  let pid = readPid();
  if (healthy) pid = findListeningPid() || pid;

  if (!pid) {
    cleanupRuntimeFiles();
    console.log("DMR Curve Studio 当前没有运行。");
    return;
  }
  if (!isAlive(pid)) {
    cleanupRuntimeFiles();
    console.log("DMR Curve Studio 已停止，已清理过期运行记录。");
    return;
  }
  if (!healthy) {
    try {
      const info = JSON.parse(fs.readFileSync(INFO_FILE, "utf8"));
      if (Number(info.pid) !== pid || path.resolve(info.server || "") !== path.join(ROOT, "src", "server.js")) {
        throw new Error("运行记录与进程不匹配");
      }
    } catch (_error) {
      cleanupRuntimeFiles();
      throw new Error(`端口 ${PORT} 未检测到 DMR 服务，且 PID ${pid} 无法安全确认，未停止该进程。`);
    }
  }

  console.log(`正在停止 DMR Curve Studio（PID ${pid}）……`);
  try { process.kill(pid, "SIGTERM"); } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && (isAlive(pid) || await probeHealth(250))) await sleep(150);

  if (isAlive(pid) && process.platform === "win32") {
    const forced = spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { encoding: "utf8", windowsHide: true });
    if (forced.status !== 0 && isAlive(pid)) throw new Error(forced.stderr || forced.stdout || `无法停止 PID ${pid}`);
  }
  cleanupRuntimeFiles();
  console.log("DMR Curve Studio 已停止。");
}

main().catch(error => {
  console.error(error && error.message ? error.message : error);
  process.exitCode = 1;
});
