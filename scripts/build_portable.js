"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const DIST = path.join(ROOT, "dist");
const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const releaseName = `DMR-Curve-Studio-v${packageJson.version}-win-x64`;
const releaseDir = path.join(DIST, releaseName);
const archivePath = path.join(DIST, `${releaseName}.zip`);

function copy(relativePath) {
  const source = path.join(ROOT, relativePath);
  const destination = path.join(releaseDir, relativePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, { recursive: true });
}

function sha256(file) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(file));
  return hash.digest("hex");
}

function build() {
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error(`Windows x64 便携包必须在 Windows x64 环境构建，当前为 ${process.platform}/${process.arch}。`);
  }

  fs.rmSync(releaseDir, { recursive: true, force: true });
  fs.rmSync(archivePath, { force: true });
  fs.rmSync(`${archivePath}.sha256`, { force: true });
  fs.mkdirSync(path.join(releaseDir, "runtime"), { recursive: true });

  copy("public");
  copy(path.join("src", "server.js"));
  copy(path.join("src", "plr", "core.js"));
  copy(path.join("scripts", "start_dmr.js"));
  copy(path.join("scripts", "stop_dmr.js"));
  copy(path.join("fixtures", "DAT0131.PLR"));
  copy(path.join("fixtures", "curve.xls"));
  copy("README.md");
  copy("启动DMR曲线编辑器.cmd");
  copy("停止DMR曲线编辑器.cmd");
  fs.copyFileSync(process.execPath, path.join(releaseDir, "runtime", "node.exe"));

  const instructions = [
    "DMR Curve Studio Windows 便携版",
    `版本：${packageJson.version}`,
    "",
    "使用方法：",
    "1. 请先完整解压 ZIP，不要直接在压缩包中运行。",
    "2. 双击“启动DMR曲线编辑器.cmd”。",
    "3. 等待浏览器自动打开 http://127.0.0.1:17378。",
    "4. 如果 Windows 显示安全提示，请选择“仍要运行”。",
    "5. 使用完成后双击“停止DMR曲线编辑器.cmd”即可一键停止后台服务。",
    "",
    "本便携包已包含 Node.js 运行时，不需要安装 Node.js、Python 或 npm 依赖。",
    "启动日志位于解压目录下的 .runtime 文件夹。",
    "",
  ].join("\r\n");
  fs.writeFileSync(path.join(releaseDir, "使用说明.txt"), instructions, "utf8");

  const archive = spawnSync(
    "tar.exe",
    ["-a", "-c", "-f", archivePath, releaseName],
    { cwd: DIST, encoding: "utf8" },
  );
  if (archive.status !== 0) {
    throw new Error(`创建 ZIP 失败：${archive.stderr || archive.stdout || "tar.exe 返回错误"}`);
  }

  const checksum = sha256(archivePath);
  fs.writeFileSync(`${archivePath}.sha256`, `${checksum}  ${path.basename(archivePath)}\n`, "utf8");
  const megabytes = (fs.statSync(archivePath).size / 1024 / 1024).toFixed(1);
  console.log(`便携包目录：${releaseDir}`);
  console.log(`ZIP：${archivePath} (${megabytes} MB)`);
  console.log(`SHA-256：${checksum}`);
}

try {
  build();
} catch (error) {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
}
