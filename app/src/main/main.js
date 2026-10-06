'use strict';
/**
 * Electron 主进程：把本地服务包成一个独立桌面窗口。
 * 说明：界面仍旧走 127.0.0.1 上的本地 HTTP 服务（同源、便于调试），
 *      服务与窗口同生命周期；窗口关闭即退出（可被托盘/菜单退出）。
 */

const { app, BrowserWindow, Menu, shell, dialog, nativeImage, ipcMain, session: electronSession } = require('electron');
const path = require('path');
const http = require('http');
const { createServer } = require('../server/index');
const { openBrowser } = require('../server/open');
const renderBridge = require('./render-bridge');

const DEFAULT_PORT = 8317;
// 浏览器兜底模式：不建窗口，只起服务并打开系统浏览器
const BROWSER_FALLBACK = process.argv.includes('--browser');
let mainWindow = null;
let httpServer = null;
let serverPort = DEFAULT_PORT;
let quitting = false;

const RENDER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * 用隐藏窗口渲染页面：给需要 JS 才能出内容的站点兜底。
 * 会在页面加载完成后等待一段时间，再取完整 HTML。
 */
async function renderPageInHiddenWindow(url, options = {}) {
  const waitMs = Math.max(0, Math.min(Number(options.waitMs) || 1500, 15000));
  const timeout = Math.max(3000, Math.min(Number(options.timeout) || 20000, 60000));
  const partition = 'persist:studio-render';
  const ses = electronSession.fromPartition(partition);
  try { ses.setUserAgent(RENDER_UA); } catch (e) { /* ignore */ }

  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    show: false,
    webPreferences: {
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      images: false,
      javascript: true,
      backgroundThrottling: false,
    },
  });

  let finished = false;
  const cleanup = () => {
    if (!win.isDestroyed()) win.destroy();
  };

  try {
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!finished) { finished = true; reject(new Error(`加载超时（${timeout}ms）`)); }
      }, timeout);

      win.webContents.once('did-finish-load', () => {
        // 给前端异步请求留时间（SPA 常见）
        setTimeout(async () => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          try {
            const body = await win.webContents.executeJavaScript('document.documentElement.outerHTML', true);
            resolve({ body: String(body || ''), finalUrl: win.webContents.getURL() || url, status: 200 });
          } catch (e) {
            reject(e);
          }
        }, waitMs);
      });

      win.webContents.once('did-fail-load', (e, code, desc, failedUrl) => {
        if (finished) return;
        // 子资源失败忽略，主文档失败才报错
        if (!failedUrl || failedUrl === url || (e && e.isMainFrame)) {
          finished = true;
          clearTimeout(timer);
          reject(new Error(`加载失败：${desc || code}`));
        }
      });

      win.loadURL(url, { userAgent: RENDER_UA }).catch((e) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        reject(e);
      });
    });
    return result;
  } finally {
    cleanup();
  }
}

/** 把渲染器注册进桥，服务端即可回调 */
function installRenderer() {
  renderBridge.setRenderer(renderPageInHiddenWindow);
}

/** 找一个可用端口（优先默认端口） */
function findPort(start) {
  return new Promise((resolve) => {
    const tryPort = (port, attempts) => {
      const tester = http.createServer();
      tester.once('error', () => {
        tester.close();
        if (attempts > 20) resolve(0);
        else tryPort(port + 1, attempts + 1);
      });
      tester.once('listening', () => {
        tester.close(() => resolve(port));
      });
      tester.listen(port, '127.0.0.1');
    };
    tryPort(start, 0);
  });
}

function startServer(port) {
  return new Promise((resolve, reject) => {
    const { server, library } = createServer({
      dataDir: path.join(app.getPath('userData'), 'data'),
      publicDir: path.join(__dirname, '..', '..', 'public'),
      samplePath: path.join(__dirname, '..', '..', '..', '折黎No.0051.json'),
      // 渲染兜底：服务端抓不到内容时会回调这个渲染器（隐藏窗口）
      renderer: renderBridge.hasRenderer() ? renderBridge.getRenderer() : null,
    });
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      httpServer = server;
      resolve(library);
    });
  });
}

function buildMenu(win) {
  const template = [
    {
      label: '文件',
      submenu: [
        {
          label: '打开数据目录',
          click: () => shell.openPath(app.getPath('userData')),
        },
        { type: 'separator' },
        { label: '退出', accelerator: 'CmdOrCtrl+Q', click: () => { quitting = true; app.quit(); } },
      ],
    },
    {
      label: '工具',
      submenu: [
        {
          label: '测试 JS 渲染兜底',
          click: async () => {
            const target = 'https://www.bige3.cc';
            try {
              const r = await renderPageInHiddenWindow(target, { waitMs: 2500, timeout: 25000 });
              const text = r.body.replace(/<script[\s\S]*?<\/script>/gi, ' ')
                .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
              dialog.showMessageBox(win, {
                type: 'info',
                title: '渲染结果',
                message: `用隐藏窗口渲染 ${target} 成功：${r.body.length} 字节`,
                detail: `可读文本 ${text.length} 字\n最终地址：${r.finalUrl}\n\n预览：\n${text.slice(0, 400)}`,
                buttons: ['好'],
              });
            } catch (e) {
              dialog.showMessageBox(win, {
                type: 'error',
                title: '渲染失败',
                message: String(e && e.message || e),
                detail: '说明当前环境无法用隐藏窗口渲染，自动造源仍会退回纯 HTTP 抓取。',
                buttons: ['好'],
              });
            }
          },
        },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '刷新', accelerator: 'F5', click: () => win.webContents.reload() },
        { label: '放大', accelerator: 'CmdOrCtrl+Plus', click: () => zoom(win, 0.1) },
        { label: '缩小', accelerator: 'CmdOrCtrl+-', click: () => zoom(win, -0.1) },
        { label: '重置缩放', accelerator: 'CmdOrCtrl+0', click: () => win.webContents.setZoomFactor(1) },
        { type: 'separator' },
        { label: '开发者工具', accelerator: 'F12', click: () => win.webContents.toggleDevTools() },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: 'Legado 规则文档',
          click: () => shell.openExternal('https://mgz0227.github.io/The-tutorial-of-Legado/Rule/source.html'),
        },
        {
          label: '关于',
          click: () => dialog.showMessageBox(win, {
            type: 'info',
            title: '关于',
            message: '书源工作台',
            detail: `Legado 书源管理与自动生成工具\n版本 ${app.getVersion()}\n本地服务端口 ${serverPort}`,
            buttons: ['好'],
          }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function zoom(win, delta) {
  const cur = win.webContents.getZoomFactor();
  const next = Math.min(3, Math.max(0.5, cur + delta));
  win.webContents.setZoomFactor(next);
}

async function createWindow() {
  installRenderer();
  const port = await findPort(DEFAULT_PORT);
  if (!port) {
    dialog.showErrorBox('启动失败', '找不到可用端口（8317 起连续 20 个端口都被占用）。');
    app.quit();
    return;
  }
  serverPort = port;
  try {
    await startServer(port);
  } catch (e) {
    dialog.showErrorBox('启动失败', '本地服务启动失败：' + e.message);
    app.quit();
    return;
  }

  if (BROWSER_FALLBACK) {
    // 只起服务 + 打开系统浏览器（无图形环境时的兜底）
    console.log('书源工作台（浏览器模式）已启动: http://127.0.0.1:' + serverPort + '/');
    openBrowser('http://127.0.0.1:' + serverPort + '/');
    return;
  }

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1024,
    minHeight: 680,
    title: '书源工作台',
    backgroundColor: '#0f1115',
    autoHideMenuBar: false,
    show: false,
    icon: undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });
  buildMenu(mainWindow);

  // 站外链接用系统浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url) && !url.includes(`127.0.0.1:${serverPort}`)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.includes(`127.0.0.1:${serverPort}`)) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });

  await mainWindow.loadURL(`http://127.0.0.1:${serverPort}/`);
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (BROWSER_FALLBACK) return; // 浏览器模式：服务继续跑，直到用户关闭进程
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('before-quit', () => {
  quitting = true;
  if (httpServer) {
    try { httpServer.close(); } catch (e) { /* ignore */ }
  }
});
