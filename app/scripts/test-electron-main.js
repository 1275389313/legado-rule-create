'use strict';
/**
 * 电子壳主进程空跑测试（两种模式）：
 *   node scripts/test-electron-main.js          窗口模式
 *   node scripts/test-electron-main.js --browser 浏览器兜底模式
 * 用假的 electron 模块替换真实模块，验证链路不依赖图形环境。
 */

const Module = require('module');
const path = require('path');
const http = require('http');

const MODE_BROWSER = process.argv.includes('--browser');
const calls = { menu: null, windowOptions: null, loadedUrl: null, external: [] };
let windowCreated = 0;

class FakeWebContents {
  constructor() { this.zoomFactor = 1; this.handlers = {}; }
  on(ev, fn) { this.handlers[ev] = fn; }
  once(ev, fn) { this.handlers[ev] = fn; }
  setWindowOpenHandler(fn) { this.openHandler = fn; }
  reload() { }
  toggleDevTools() { }
  setZoomFactor(v) { this.zoomFactor = v; }
  getZoomFactor() { return this.zoomFactor; }
}

class FakeBrowserWindow {
  constructor(options) {
    windowCreated++;
    calls.windowOptions = options;
    this.webContents = new FakeWebContents();
    this.handlers = {};
  }
  once(ev, fn) { this.handlers[ev] = fn; if (ev === 'ready-to-show') this._readyShow = fn; }
  on(ev, fn) { this.handlers[ev] = fn; }
  async loadURL(url) {
    calls.loadedUrl = url;
    const res = await new Promise((resolve, reject) => {
      http.get(url, (r) => {
        let data = '';
        r.on('data', (c) => { data += c; });
        r.on('end', () => resolve({ status: r.statusCode, body: data }));
      }).on('error', reject);
    });
    calls.loadResult = { status: res.status, length: res.body.length, hasRoot: res.body.includes('id="panel-create"') };
    if (this._readyShow) this._readyShow();
  }
  show() { calls.shown = true; }
  static getAllWindows() { return windowCreated ? [{}] : []; }
}

const fakeElectron = {
  app: {
    getPath: (name) => path.join(__dirname, '..', '.test-userdata', name),
    whenReady: () => Promise.resolve(),
    on: () => {},
    quit: () => { calls.quit = true; },
    getVersion: () => '0.1.0',
  },
  BrowserWindow: FakeBrowserWindow,
  Menu: { setApplicationMenu: (m) => { calls.menu = m; }, buildFromTemplate: (t) => ({ template: t }) },
  shell: { openExternal: (u) => { calls.external.push(u); return Promise.resolve(); }, openPath: () => Promise.resolve() },
  dialog: {
    showErrorBox: (t, m) => { calls.errorBox = { t, m }; },
    showMessageBox: () => Promise.resolve({ response: 0 }),
  },
  nativeImage: {},
};

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return 'fake-electron';
  return origResolve.call(this, request, ...rest);
};
require.cache['fake-electron'] = { id: 'fake-electron', filename: 'fake-electron', loaded: true, exports: fakeElectron };

process.env.APPDATA = path.join(__dirname, '..', '.test-userdata');
require('../src/main/main.js');

setTimeout(async () => {
  console.log('模式:', MODE_BROWSER ? '浏览器兜底' : '桌面窗口');
  console.log('窗口创建次数:', windowCreated);
  if (!MODE_BROWSER) {
    console.log('窗口尺寸:', calls.windowOptions && `${calls.windowOptions.width}x${calls.windowOptions.height}`);
    console.log('webPreferences:', JSON.stringify(calls.windowOptions && calls.windowOptions.webPreferences));
  }
  console.log('加载地址:', calls.loadedUrl || '(未建窗口)');
  console.log('页面加载结果:', JSON.stringify(calls.loadResult));
  console.log('菜单项:', calls.menu ? calls.menu.template.map((m) => m.label).join(' / ') : '(未设置)');
  if (calls.errorBox) console.log('错误弹窗:', JSON.stringify(calls.errorBox));

  let ok;
  if (MODE_BROWSER) {
    ok = windowCreated === 0 && !calls.errorBox;
    // 浏览器模式下服务也应该在跑：用默认端口探一下
    const alive = await new Promise((resolve) => {
      const req = http.get('http://127.0.0.1:8317/api/health', (r) => resolve(r.statusCode === 200));
      req.on('error', () => resolve(false));
      req.setTimeout(2000, () => { req.destroy(); resolve(false); });
    });
    console.log('本地服务存活:', alive);
    ok = ok && alive;
  } else {
    ok = !calls.errorBox && calls.loadResult && calls.loadResult.status === 200 && calls.loadResult.hasRoot;
  }
  console.log('\n结论:', ok ? '✅ 链路正常' : '❌ 存在问题');
  process.exit(ok ? 0 : 1);
}, 2500);
