"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const RUNTIME = path.join(ROOT, ".runtime");
const SERVER = path.join(ROOT, "src", "server.js");
const HOST = process.env.DMR_HOST || "127.0.0.1";
const PORT = Number(process.env.DMR_PORT || 17378);
const BROWSER_HOST = HOST === "0.0.0.0" || HOST === "::" ? "127.0.0.1" : HOST;
const BASE_URL = `http://${BROWSER_HOST}:${PORT}`;
const HEALTH_URL = `${BASE_URL}/api/health`;
const START_TIMEOUT_MS = Number(process.env.DMR_START_TIMEOUT_MS || 15000);

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function probeHealth(timeoutMs = 800) {
  return new Promise((resolve) => {
    const request = http.get(HEALTH_URL, { timeout: timeoutMs }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        try {
          const result = JSON.parse(body);
          resolve(response.statusCode === 200 && result.ok === true && result.application === "DMR Curve Studio");
        } catch (_error) {
          resolve(false);
        }
      });
    });
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve(false));
  });
}

function openBrowser(url) {
  if (process.env.DMR_NO_BROWSER === "1") return;

  let command;
  let args;
  if (process.platform === "win32") {
    command = "explorer.exe";
    args = [url];
  } else if (process.platform === "darwin") {
    command = "open";
    args = [url];
  } else {
    command = "xdg-open";
    args = [url];
  }

  const opener = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  opener.on("error", (error) => {
    console.error(`服务已启动，但浏览器打开失败：${error.message}`);
    console.error(`请手动访问 ${url}`);
  });
  opener.unref();
}

function tail(file, maxBytes = 6000) {
  try {
    const stat = fs.statSync(file);
    const start = Math.max(0, stat.size - maxBytes);
    const size = stat.size - start;
    const descriptor = fs.openSync(file, "r");
    const buffer = Buffer.alloc(size);
    fs.readSync(descriptor, buffer, 0, size, start);
    fs.closeSync(descriptor);
    return buffer.toString("utf8").trim();
  } catch (_error) {
    return "";
  }
}

function startServer() {
  fs.mkdirSync(RUNTIME, { recursive: true });
  const stdoutPath = path.join(RUNTIME, "dmr-server.log");
  const stderrPath = path.join(RUNTIME, "dmr-server-error.log");
  const timestamp = new Date().toISOString();
  fs.writeFileSync(stdoutPath, `[${timestamp}] 正在启动 DMR Curve Studio\n`, "utf8");
  fs.writeFileSync(stderrPath, "", "utf8");

  const stdout = fs.openSync(stdoutPath, "a");
  const stderr = fs.openSync(stderrPath, "a");
  let child;
  try {
    child = spawn(process.execPath, [SERVER], {
      cwd: ROOT,
      env: { ...process.env, DMR_HOST: HOST, DMR_PORT: String(PORT) },
      detached: true,
      windowsHide: true,
      stdio: ["ignore", stdout, stderr],
    });
  } finally {
    fs.closeSync(stdout);
    fs.closeSync(stderr);
  }

  child.unref();
  fs.writeFileSync(path.join(RUNTIME, "dmr-server.pid"), String(child.pid), "utf8");
  fs.writeFileSync(path.join(RUNTIME, "dmr-server.json"), JSON.stringify({
    pid: child.pid, host: HOST, port: PORT, server: SERVER, startedAt: timestamp,
  }, null, 2), "utf8");
  return { child, stdoutPath, stderrPath };
}

async function waitForServer(child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeHealth()) return true;
    if (child.exitCode !== null) return false;
    await sleep(250);
  }
  return false;
}

async function main() {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (!Number.isInteger(nodeMajor) || nodeMajor < 18) {
    throw new Error(`需要 Node.js 18 或更高版本，当前版本为 ${process.versions.node}。`);
  }

  if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
    throw new Error(`DMR_PORT 无效：${process.env.DMR_PORT || ""}`);
  }

  if (await probeHealth()) {
    console.log(`DMR Curve Studio 已在运行：${BASE_URL}`);
    openBrowser(BASE_URL);
    return;
  }

  console.log("正在启动 DMR Curve Studio，请稍候……");
  const server = startServer();
  const spawnError = new Promise((resolve) => server.child.once("error", resolve));
  const started = await Promise.race([
    waitForServer(server.child, START_TIMEOUT_MS),
    spawnError.then(() => false),
  ]);

  if (started) {
    console.log(`启动成功：${BASE_URL}`);
    openBrowser(BASE_URL);
    return;
  }

  if (server.child.exitCode === null) server.child.kill();
  const errorLog = tail(server.stderrPath);
  const outputLog = tail(server.stdoutPath);
  const details = errorLog || outputLog || "服务未在规定时间内通过健康检查。";
  throw new Error(`无法启动本地服务。\n${details}`);
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
