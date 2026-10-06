'use strict';
/**
 * 制作免安装的绿色版目录（不依赖任何打包工具）：
 *   node scripts/package-portable.js
 * 产物：<仓库根>/dist/书源工作台/
 *   ├─ 启动书源工作台.bat
 *   ├─ app/           程序本体（含 node_modules/electron）
 *   └─ 折黎No.0051.json  样本书源（首次启动自动导入）
 * 把整个文件夹拷到别的电脑（无需装 Node）双击 bat 即可运行。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const APP = path.join(ROOT, 'app');
const DIST = path.join(ROOT, 'dist', '书源工作台');
const TARGET_APP = path.join(DIST, 'app');

const SKIP_DIRS = new Set(['.npm-cache', '.electron-cache', '.test-userdata', 'data', 'screenshots', 'scripts']);
const SKIP_FILES = new Set(['.gitignore']);

function copyDir(src, dest, isRoot) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (isRoot && entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    if (!isRoot && entry.isDirectory() && entry.name === 'data') continue;
    if (!isRoot && SKIP_FILES.has(entry.name)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d, false);
    else fs.copyFileSync(s, d);
  }
}

function main() {
  if (!fs.existsSync(path.join(APP, 'node_modules', 'electron', 'dist', 'electron.exe'))) {
    console.error('缺少 Electron 运行环境：请先在 app 目录执行 npm install');
    process.exit(1);
  }
  console.log('目标目录：' + DIST);
  fs.rmSync(DIST, { recursive: true, force: true });
  copyDir(APP, TARGET_APP, true);

  const bat = `@echo off
chcp 65001 >nul
title 书源工作台
cd /d "%~dp0app"
set "ELECTRON_RUN_AS_NODE="
set "ELECTRON_DISABLE_SECURITY_WARNINGS=1"
if exist "node_modules\\electron\\dist\\electron.exe" (
  "node_modules\\electron\\dist\\electron.exe" .
  if not errorlevel 1 goto :eof
)
echo.
echo [!] 桌面窗口启动失败，改用浏览器模式...
where node >nul 2>nul
if errorlevel 1 (
  echo 本机没有 Node.js，无法使用浏览器模式。
  pause
  goto :eof
)
cd /d "%~dp0"
node "app\\src\\server\\index.js"
pause
`;
  fs.writeFileSync(path.join(DIST, '启动书源工作台.bat'), bat.replace(/\n/g, '\r\n'), 'utf8');

  const sample = path.join(ROOT, '折黎No.0051.json');
  if (fs.existsSync(sample)) fs.copyFileSync(sample, path.join(DIST, '折黎No.0051.json'));

  const readme = `书源工作台（绿色版）

1. 双击「启动书源工作台.bat」
2. 会打开独立窗口（失败则自动用系统浏览器打开 http://127.0.0.1:8317/）
3. 首次启动自动导入同目录下的 折黎No.0051.json（504 个书源）
4. 书源库数据保存在 %APPDATA%\\legado-source-studio\\data

「网址造源」：粘贴小说站网址 → 开始生成 → 真机校验 → 保存 → 导出 JSON → 传到手机用「阅读」APP 导入。
`;
  fs.writeFileSync(path.join(DIST, '使用说明.txt'), readme.replace(/\n/g, '\r\n'), 'utf8');

  // 统计体积
  let bytes = 0;
  let files = 0;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else { bytes += fs.statSync(p).size; files++; }
    }
  };
  walk(DIST);
  console.log(`完成：${files} 个文件，共 ${(bytes / 1024 / 1024).toFixed(1)} MB`);
  console.log('整个文件夹可以直接拷走使用（目标电脑无需安装 Node.js）。');
}

main();
