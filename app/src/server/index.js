'use strict';
/**
 * 本地服务：为 PC 端界面提供 HTTP API。
 * 端点：
 *   GET  /api/health
 *   GET  /api/library            书源列表（?keyword=&group=）
 *   GET  /api/library/groups     分组
 *   GET  /api/library/stats
 *   POST /api/library/import     导入（body: {sources:[...]} 或 {path:"..."}）
 *   POST /api/library/source     新增/更新单个书源
 *   DELETE /api/library/source   删除（?url=）
 *   GET  /api/library/export     导出（?urls=a,b）
 *   POST /api/generate           自动生成（{url, testKey}）→ SSE 进度或 JSON
 *   POST /api/validate           校验书源（{source, key}）
 *   POST /api/preview/search     预览搜索（{source, key, page}）
 *   POST /api/preview/toc        预览目录（{source, bookUrl}）
 *   POST /api/preview/content    预览正文（{source, chapterUrl}）
 *   POST /api/eval               单条规则求值（{source, url|html, rule, baseUrl}）
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { SourceLibrary } = require('./library');
const { SourceGenerator } = require('../core/generator');
const { SourceSession } = require('../core/session');
const { AnalyzeRule } = require('../core/rule');
const { HttpClient } = require('../core/http');
const { needsJsRender } = require('../core/render');
const { wrapRenderer } = require('../main/render-bridge');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function createServer(opts = {}) {
  const dataDir = opts.dataDir || process.env.STUDIO_DATA_DIR || path.join(__dirname, '..', '..', 'data');
  const publicDir = opts.publicDir || path.join(__dirname, '..', '..', 'public');
  const library = new SourceLibrary(dataDir);
  const generateJobs = new Map();
  // 渲染兜底：Electron 主进程会注入 renderer
  const renderer = opts.renderer && typeof opts.renderer.render === 'function'
    ? wrapRenderer((url, o) => opts.renderer.render(url, o))
    : null;
  if (renderer) console.log('已启用 JS 渲染兜底（隐藏窗口）');

  /** 统一构造会话，带上渲染器 */
  const makeSession = (source, options = {}) => new SourceSession(source, Object.assign({
    renderer,
    timeout: options.timeout || 20000,
  }, options));

  // 首次启动且书源库为空时，自动导入工作区里的样本书源，方便立刻上手
  try {
    if (opts.autoImportSample !== false && library.sources.length === 0) {
      const sample = [
        opts.samplePath,
        path.resolve(__dirname, '..', '..', '..', '折黎No.0051.json'),
        path.resolve(__dirname, '..', '..', 'data', 'sample.json'),
      ].filter(Boolean).find((f) => fs.existsSync(f));
      if (sample) {
        const data = JSON.parse(fs.readFileSync(sample, 'utf8'));
        const stats = library.import(data, { fileName: path.basename(sample) });
        console.log(`已自动导入样本书源 ${stats.added} 个（${path.basename(sample)}）`);
      }
    }
  } catch (e) {
    console.error('自动导入样本书源失败:', e.message);
  }

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://localhost');
    const p = u.pathname;
    try {
      if (p.startsWith('/api/')) {
        await handleApi(req, res, u, { library, generateJobs, dataDir, samplePath: opts.samplePath, renderer });
        return;
      }
      serveStatic(res, publicDir, p);
    } catch (e) {
      sendJson(res, 500, { error: String(e && e.message || e) });
    }
  });
  server.on('error', (e) => {
    console.error('服务器错误:', e.message);
  });
  return { server, library };
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 64 * 1024 * 1024) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { resolve({ _raw: raw }); }
    });
    req.on('error', reject);
  });
}

function serveStatic(res, publicDir, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.join(publicDir, rel.replace(/^\/+/, ''));
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(publicDir))) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404');
    return;
  }
  const ext = path.extname(resolved).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(resolved).pipe(res);
}

async function handleApi(req, res, u, ctx) {
  const { library, generateJobs } = ctx;
  const renderer = ctx.renderer || null;
  const makeSessionApi = (source, options = {}) => new SourceSession(source, Object.assign({ renderer, timeout: 20000 }, options));
  const p = u.pathname;
  const method = req.method.toUpperCase();

  if (p === '/api/health') return sendJson(res, 200, { ok: true, version: '0.1.0', time: Date.now() });

  // 能力探测：前端据此决定是否显示「JS 渲染」相关开关
  if (p === '/api/capabilities') {
    return sendJson(res, 200, {
      jsRender: !!renderer,
      mode: renderer ? 'electron' : 'http',
      features: {
        generate: true,
        validate: true,
        library: true,
        debug: true,
        jsRender: !!renderer,
      },
    });
  }

  // 渲染测试：对比普通抓取与浏览器渲染的结果差异
  if (p === '/api/render-test' && method === 'POST') {
    const body = await readBody(req);
    if (!body.url) return sendJson(res, 400, { error: '缺少 url' });
    const httpClient = new HttpClient({ timeout: 20000 });
    const plain = await httpClient.request(body.url).catch((e) => ({ error: e.message }));
    const verdict = plain.error ? { needed: true, reason: plain.error } : needsJsRender(plain.body);
    const out = {
      url: body.url,
      plain: plain.error ? { error: plain.error } : { length: plain.body.length, status: plain.status },
      needed: verdict.needed,
      reason: verdict.reason,
      renderAvailable: !!renderer,
    };
    if (renderer && (verdict.needed || body.force)) {
      try {
        const r = await renderer.render(body.url, { waitMs: body.waitMs || 1500, timeout: 25000 });
        out.rendered = { length: r.body.length, chars: r.body.replace(/<[^>]+>/g, '').replace(/\s+/g, '').length, finalUrl: r.finalUrl };
        out.improved = r.body.length > (plain.body ? plain.body.length : 0);
        out.preview = r.body.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
      } catch (e) {
        out.renderError = String(e && e.message || e);
      }
    }
    return sendJson(res, 200, out);
  }

  // 示例书源（工作区根目录的 折黎No.0051.json）
  if (p === '/api/sample' && method === 'GET') {
    const candidates = [
      ctx.samplePath,
      path.resolve(__dirname, '..', '..', '..', '折黎No.0051.json'),
      path.resolve(__dirname, '..', '..', 'data', 'sample.json'),
    ].filter(Boolean);
    for (const file of candidates) {
      if (fs.existsSync(file)) {
        const sources = JSON.parse(fs.readFileSync(file, 'utf8'));
        return sendJson(res, 200, { fileName: path.basename(file), count: sources.length, sources });
      }
    }
    return sendJson(res, 404, { error: '示例文件未找到' });
  }

  if (p === '/api/library' && method === 'GET') {
    return sendJson(res, 200, {
      sources: library.list({
        keyword: u.searchParams.get('keyword') || '',
        group: u.searchParams.get('group') || '',
        enabled: u.searchParams.get('enabled'),
      }),
      stats: library.stats(),
      groups: library.groups(),
    });
  }
  if (p === '/api/library/stats') return sendJson(res, 200, library.stats());
  if (p === '/api/library/groups') return sendJson(res, 200, library.groups());

  // 查一个 URL 是否已在书源库里（前端保存前先问，避免静默覆盖）
  if (p === '/api/library/find' && method === 'GET') {
    const url = String(u.searchParams.get('url') || '').replace(/\/+$/, '');
    const found = library.get(url);
    return sendJson(res, 200, {
      exists: !!found,
      source: found ? { bookSourceName: found.bookSourceName, bookSourceUrl: found.bookSourceUrl, bookSourceGroup: found.bookSourceGroup } : null,
    });
  }

  if (p === '/api/library/import' && method === 'POST') {
    const body = await readBody(req);
    let data = body.sources || body.data || null;
    let fileName = body.fileName || '';
    if (!data && body.path) {
      const p2 = body.path;
      if (!fs.existsSync(p2)) return sendJson(res, 400, { error: '文件不存在: ' + p2 });
      data = JSON.parse(fs.readFileSync(p2, 'utf8'));
      fileName = path.basename(p2);
    }
    if (!data) return sendJson(res, 400, { error: '缺少 sources 或 path' });
    const stats = library.import(data, { fileName, overwrite: body.overwrite !== false });
    return sendJson(res, 200, { ok: true, stats, total: library.sources.length });
  }

  if (p === '/api/library/source' && (method === 'POST' || method === 'PUT')) {
    const body = await readBody(req);
    const src = body.source || body;
    const saved = library.upsert(src);
    return sendJson(res, 200, { ok: true, source: saved });
  }
  if (p === '/api/library/source' && method === 'DELETE') {
    const url = u.searchParams.get('url');
    return sendJson(res, 200, { ok: library.remove(url) });
  }

  if (p === '/api/library/export' && method === 'GET') {
    const urls = (u.searchParams.get('urls') || '').split(',').filter(Boolean);
    return sendJson(res, 200, library.export(urls));
  }

  // ---- 自动生成（SSE 进度） ----
  if (p === '/api/generate' && method === 'POST') {
    const body = await readBody(req);
    if (!body.url) return sendJson(res, 400, { error: '缺少 url' });
    const useSse = u.searchParams.get('sse') === '1' || (req.headers.accept || '').includes('text/event-stream');
    if (!useSse) {
      const gen = new SourceGenerator({ testKey: body.testKey, renderer, useRender: body.useRender !== false });
      const result = await gen.generate(body.url, { testKey: body.testKey });
      return sendJson(res, 200, result);
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const send = (event, data) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const gen = new SourceGenerator({
      testKey: body.testKey,
      renderer,
      useRender: body.useRender !== false,
      onProgress: (info) => send('progress', info),
    });
    try {
      const result = await gen.generate(body.url, { testKey: body.testKey });
      send('result', result);
    } catch (e) {
      send('error', { message: String(e && e.message || e) });
    }
    res.end();
    return;
  }

  // ---- 校验 ----
  if (p === '/api/validate' && method === 'POST') {
    const body = await readBody(req);
    const source = body.source;
    if (!source) return sendJson(res, 400, { error: '缺少 source' });
    const session = makeSessionApi(source, { timeout: body.timeout || 20000 });
    const report = await session.validate(body.key || '斗破苍穹', { maxPages: body.maxPages || 3 });
    return sendJson(res, 200, report);
  }

  // ---- 预览：搜索 ----
  if (p === '/api/preview/search' && method === 'POST') {
    const body = await readBody(req);
    const session = makeSessionApi(body.source, { timeout: body.timeout || 20000 });
    const out = await session.search(body.key || '斗破苍穹', Number(body.page) || 1);
    return sendJson(res, 200, summarizeSearch(out));
  }
  // ---- 预览：发现 ----
  if (p === '/api/preview/explore' && method === 'POST') {
    const body = await readBody(req);
    const session = makeSessionApi(body.source, { timeout: body.timeout || 20000 });
    const out = await session.explore(body.url, Number(body.page) || 1);
    return sendJson(res, 200, summarizeSearch(out));
  }
  // ---- 预览：详情 ----
  if (p === '/api/preview/bookInfo' && method === 'POST') {
    const body = await readBody(req);
    const session = makeSessionApi(body.source, { timeout: body.timeout || 20000 });
    const out = await session.bookInfo({ bookUrl: body.bookUrl, name: body.name || '' });
    return sendJson(res, 200, { ok: out.ok, errors: out.errors, info: out.info });
  }
  // ---- 预览：目录 ----
  if (p === '/api/preview/toc' && method === 'POST') {
    const body = await readBody(req);
    const session = makeSessionApi(body.source, { timeout: body.timeout || 20000 });
    const out = await session.toc({ bookUrl: body.bookUrl, name: body.name || '' });
    return sendJson(res, 200, {
      ok: out.ok, errors: out.errors, url: out.url,
      count: out.chapters.length, chapters: out.chapters.slice(0, 200),
    });
  }
  // ---- 预览：正文 ----
  if (p === '/api/preview/content' && method === 'POST') {
    const body = await readBody(req);
    const session = makeSessionApi(body.source, { timeout: body.timeout || 20000 });
    const out = await session.content({ bookUrl: body.bookUrl }, { name: body.name || '', url: body.chapterUrl }, { maxPages: body.maxPages || 3 });
    return sendJson(res, 200, { ok: out.ok, errors: out.errors, length: out.length, text: out.text.slice(0, 20000), pages: out.pages });
  }

  // ---- 单条规则求值 ----
  if (p === '/api/eval' && method === 'POST') {
    const body = await readBody(req);
    const httpClient = new HttpClient({ timeout: 20000 });
    let html = body.html;
    let baseUrl = body.baseUrl || '';
    let responseInfo = null;
    if (!html && body.url) {
      const r = await httpClient.request(body.url, body.options || {});
      html = r.body;
      baseUrl = r.finalUrl || body.url;
      responseInfo = { status: r.status, length: r.body.length, charset: r.charset, url: baseUrl };
    }
    if (html === undefined) return sendJson(res, 400, { error: '缺少 url 或 html' });
    const analyzer = new AnalyzeRule({ content: html, baseUrl, source: body.source || {}, vars: {} });
    const results = {};
    for (const rule of (body.rules || [body.rule]).filter(Boolean)) {
      try {
        const strings = analyzer.getStringList(rule);
        results[rule] = {
          values: strings.slice(0, 30),
          count: strings.length,
          elements: body.withElements ? analyzer.getElements(rule).length : undefined,
        };
      } catch (e) {
        results[rule] = { error: String(e && e.message || e) };
      }
    }
    return sendJson(res, 200, { ok: true, response: responseInfo, results, htmlPreview: html.slice(0, 4000) });
  }

  // ---- 抓取原始页面（用于界面调试） ----
  if (p === '/api/fetch' && method === 'POST') {
    const body = await readBody(req);
    const httpClient = new HttpClient({ timeout: body.timeout || 20000 });
    const r = await httpClient.request(body.url, body.options || {});
    return sendJson(res, 200, {
      status: r.status, url: r.finalUrl || body.url, charset: r.charset,
      length: r.body.length, body: r.body.slice(0, body.limit || 200000),
    });
  }

  return sendJson(res, 404, { error: 'unknown api: ' + p });
}

function summarizeSearch(out) {
  return {
    ok: out.ok,
    urls: out.urls,
    errors: out.errors,
    count: out.books.length,
    books: out.books.slice(0, 50),
  };
}

module.exports = { createServer };

// 直接运行时启动
if (require.main === module) {
  const port = Number(process.env.PORT || process.argv[2] || 8317);
  const { server } = createServer({});
  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}/`;
    console.log('书源工作台已启动: ' + url);
    const { openBrowser } = require('./open');
    openBrowser(url);
  });
}


