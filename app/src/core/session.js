'use strict';
/**
 * 书源执行会话：把 Legado 书源规则真正跑起来。
 * 提供：搜索 / 发现 / 详情 / 目录 / 正文 五步，以及每一步的诊断信息。
 * 这既是“校验器”，也是“自动生成书源”的自测引擎。
 */

const { AnalyzeRule, absUrl } = require('./rule');
const { HttpClient, parseUrlRule } = require('./http');
const { runJsRule } = require('./jsexec');
const { decodeEntities } = require('./dom');
const { needsJsRender } = require('./render');

const JSON_HINT_RULES = /^(\$\.|@json:|\$\[)/;
const JS_PREFIX = /^@js:|^<js>/i;

class SourceSession {
  constructor(source, opts = {}) {
    this.source = source || {};
    this.http = opts.http || new HttpClient({ timeout: opts.timeout || 20000, log: opts.log });
    // 渲染兜底（Electron 主进程注入渲染器时才生效）
    this.renderer = opts.renderer || null;
    this.useRender = opts.useRender !== false && !!opts.renderer;
    this.vars = Object.create(null);
    this.logs = [];
    this.log = (msg) => { this.logs.push(String(msg)); if (opts.log) opts.log(String(msg)); };
    this.diagnostics = [];
  }

  /**
   * 抓取页面：普通 HTTP 抓不到内容时，用浏览器渲染兜底。
   * 返回结构与 HttpClient.request 一致。
   */
  async requestPage(url, options = {}) {
    const res = await this.http.request(url, options);
    if (!this.useRender) return res;
    const verdict = needsJsRender(res.body, options.renderOptions);
    if (!verdict.needed) return res;
    try {
      const out = await this.renderer.render(url, {
        waitMs: options.waitMs || 1500,
        timeout: options.timeout || this.http.timeout,
      });
      if (out && typeof out.body === 'string' && out.body.length > res.body.length) {
        this.log(`[render] ${verdict.reason}，已改用浏览器渲染 ${url}`);
        return Object.assign({}, res, { body: out.body, finalUrl: out.finalUrl || res.finalUrl, rendered: true });
      }
    } catch (e) {
      this.log(`[render] 渲染失败：${e.message}`);
    }
    return res;
  }

  rule(group, field) {
    const g = this.source[group];
    if (!g) return '';
    const v = g[field];
    if (v === undefined || v === null) return '';
    if (typeof v !== 'string') return String(v);
    return v;
  }

  baseUrl() {
    return String(this.source.bookSourceUrl || '').replace(/\/+$/, '');
  }

  /**
   * 把可能是相对路径的 URL 补全为绝对 URL。
   * 不用 new URL()，因为中文关键字会被百分号编码（部分站点不接受）。
   */
  resolveUrl(url, base) {
    let u = String(url === undefined || url === null ? '' : url).trim();
    if (!u) return '';
    if (/^[a-zA-Z][\w+.-]*:/.test(u)) return u; // 已是绝对 URL
    const b = String(base || this.baseUrl() || '').replace(/\/+$/, '');
    if (!b) return u;
    if (u.startsWith('//')) return b.split(':')[0] + ':' + u;
    if (u.startsWith('/')) return b + u;
    return b + '/' + u.replace(/^\.\//, '');
  }

  /** 变量放置（legado @put/@get）：解析规则中的 @put:{a:"rule"} */
  handlePut(rule, analyzer) {
    const s = String(rule || '');
    const idx = s.indexOf('@put:');
    if (idx === -1) return '';
    const jsonish = s.slice(idx + 5);
    const objMatch = jsonish.match(/\{[\s\S]*\}/);
    if (!objMatch) return s.slice(0, idx);
    try {
      const body = objMatch[0].replace(/([{,]\s*)([\w$]+)\s*:/g, '$1"$2":');
      const parsed = JSON.parse(body);
      for (const [k, v] of Object.entries(parsed)) {
        this.vars[k] = analyzer ? analyzer.getString(String(v).replace(/^["']|["']$/g, '')) : '';
      }
    } catch (e) { /* ignore */ }
    return (s.slice(0, idx) + s.slice(idx + 5 + objMatch.index + objMatch[0].length)).trim();
  }

  applyGet(rule) {
    return String(rule || '').replace(/@get:\{([\w$]+)\}/g, (m, name) => {
      const v = this.vars[name];
      return v === undefined ? '' : String(v);
    });
  }

  /** 构造分析器上下文（含 result/baseUrl 等 js 变量） */
  makeAnalyzer(content, baseUrl, extra = {}) {
    const analyzer = new AnalyzeRule({
      content,
      baseUrl,
      source: this.source,
      vars: this.vars,
      ctx: Object.assign({}, extra),
    });
    return analyzer;
  }

  isJsonContent(res, rule) {
    const ct = (res.headers && (res.headers['content-type'] || '')) || '';
    if (/json/i.test(ct)) return true;
    if (JSON_HINT_RULES.test(String(rule || '').trim())) return true;
    const body = res.body.trim();
    return (body.startsWith('{') || body.startsWith('[')) && !body.startsWith('<!');
  }

  /** 搜索 */
  async search(key, page = 1) {
    const out = { ok: false, step: 'search', key, page, books: [], errors: [], urls: [] };
    const tpl = this.rule('', 'searchUrl') || this.source.searchUrl || '';
    if (!tpl) { out.errors.push('书源未配置 searchUrl'); return out; }
    for (const one of splitLines(tpl)) {
      if (!one.trim()) continue;
      const url = this.buildSearchUrl(one.trim(), key, page);
      out.urls.push(url);
      try {
        const res = await this.requestPage(url, this.requestOptions());
        const json = this.isJsonContent(res, this.rule('ruleSearch', 'bookList'));
        const analyzer = this.makeAnalyzer(json ? res.body : res.body, url, { key, page, json });
        if (json) analyzer.forcedJson = true;
        analyzer.setContent(res.body);
        const bookListRule = this.rule('ruleSearch', 'bookList');
        const items = this.collectList(analyzer, bookListRule);
        const books = [];
        for (const item of items) {
          const book = this.itemToBook(item, analyzer, 'ruleSearch', url);
          if (book.name || book.bookUrl) books.push(book);
        }
        if (books.length) {
          out.ok = true;
          out.books = books;
          out.html = res.body;
          return out;
        }
        out.errors.push(`书源 ${one} 未解析到书籍列表`);
        out.html = res.body;
      } catch (e) {
        out.errors.push(`请求失败 ${url}: ${e.message}`);
      }
    }
    return out;
  }

  buildSearchUrl(tpl, key, page) {
    let url = tpl;
    // {{key}} / {{page}} 里可以写 js
    url = url.replace(/\{\{([\s\S]*?)\}\}/g, (m, expr) => {
      const e = expr.trim();
      try {
        const v = runJsRule(e, { key, page, baseUrl: this.baseUrl(), vars: this.vars, ctx: { key, page } });
        return v === undefined || v === null ? '' : String(v);
      } catch (err) {
        if (e === 'key') return encodeURIComponent(key);
        if (e === 'page') return String(page);
        return '';
      }
    });
    // 处理 <,{{page}}> 形式：第一页不带页参数
    url = url.replace(/<,([^>]*)>/g, (m, inner) => (Number(page) <= 1 ? '' : inner));
    url = url.replace(/\{\{page\}\}/g, String(page));
    return this.resolveUrl(url);
  }

  requestOptions() {
    const opts = {};
    const header = this.source.header;
    if (header && String(header).trim()) {
      const h = String(header).trim();
      if (h.startsWith('@js:') || h.startsWith('<js>')) {
        try {
          const parsed = JSON.parse(runJsRule(h, { baseUrl: this.baseUrl(), vars: this.vars }));
          opts.headers = parsed;
        } catch (e) { this.log('header js 解析失败: ' + e.message); }
      } else {
        try {
          opts.headers = JSON.parse(h);
        } catch (e) {
          this.log('header 不是合法 JSON: ' + h.slice(0, 60));
        }
      }
    }
    return opts;
  }

  /** 取列表（区分 js / 正则 AllInOne / 普通规则） */
  collectList(analyzer, listRule) {
    const rule = String(listRule || '').trim();
    if (!rule || rule === '-') {
      return analyzer.getElements('');
    }
    if (JS_PREFIX.test(rule)) {
      try {
        const values = analyzer.runJs(rule.replace(/^@js:/, '').replace(/^<js>/i, '').replace(/<\/js>$/i, ''), []);
        return values;
      } catch (e) {
        this.log('列表 js 规则执行失败: ' + e.message);
        return [];
      }
    }
    return analyzer.getElements(rule);
  }

  /** 把列表项解析成书籍对象 */
  itemToBook(item, parentAnalyzer, group, pageUrl) {
    const mk = (field) => {
      const rule = this.rule(group, field);
      if (!rule) return '';
      try {
        const a = this.makeAnalyzer(item, pageUrl, {});
        a.json = parentAnalyzer && parentAnalyzer.json !== null && parentAnalyzer.json !== undefined && typeof item === 'object' && item.type === undefined
          ? item : a.json;
        if (typeof item === 'object' && item !== null && item.type === undefined) {
          a.forcedJson = true;
          a.json = item;
          a.doc = null;
          a.node = null;
        }
        return String(a.getString(this.applyGet(rule)) || '').trim();
      } catch (e) {
        return '';
      }
    };
    const book = {
      name: mk('name'),
      author: mk('author'),
      kind: mk('kind'),
      wordCount: mk('wordCount'),
      lastChapter: mk('lastChapter'),
      intro: mk('intro'),
      coverUrl: mk('coverUrl'),
      bookUrl: '',
    };
    const urlRule = this.rule(group, 'bookUrl');
    if (urlRule) {
      try {
        const a = this.makeAnalyzer(item, pageUrl, {});
        if (typeof item === 'object' && item !== null && item.type === undefined) { a.forcedJson = true; a.json = item; a.doc = null; a.node = null; }
        let raw = String(a.getString(this.applyGet(urlRule)) || '').trim();
        raw = this.extractUrl(raw);
        book.bookUrl = absUrl(pageUrl, raw);
        if (book.bookUrl.startsWith('@js:') || book.bookUrl.includes('@js:')) book.bookUrl = '';
      } catch (e) { /* ignore */ }
    }
    if (book.coverUrl && !/^https?:/i.test(book.coverUrl)) book.coverUrl = absUrl(pageUrl, book.coverUrl);
    return book;
  }

  /** 从 js 结果中提取 url（可能带 json 包装） */
  extractUrl(raw) {
    if (!raw) return '';
    let s = String(raw).trim();
    if (s.startsWith('{') && s.includes('"url"')) {
      try { const o = JSON.parse(s); if (o.url) return String(o.url); } catch (e) { /* ignore */ }
    }
    const m = s.match(/^https?:\/\/[^\s"'<>]+/) || s.match(/^\/[^\s"'<>]*/);
    if (m) return m[0];
    return s.split(/\s/)[0] || '';
  }

  /** 发现（分类）列表 */
  async explore(categoryUrl, page = 1) {
    const out = { ok: false, step: 'explore', page, books: [], errors: [], urls: [] };
    const url = this.buildExploreUrl(categoryUrl, page);
    out.urls.push(url);
    try {
      const res = await this.requestPage(url, this.requestOptions());
      const json = this.isJsonContent(res, this.rule('ruleExplore', 'bookList'));
      const analyzer = this.makeAnalyzer(res.body, url, { page, json });
      if (json) analyzer.forcedJson = true;
      analyzer.setContent(res.body);
      const items = this.collectList(analyzer, this.rule('ruleExplore', 'bookList'));
      const books = [];
      for (const item of items) {
        const b = this.itemToBook(item, analyzer, 'ruleExplore', url);
        if (b.name || b.bookUrl) books.push(b);
      }
      out.books = books;
      out.ok = books.length > 0;
      out.html = res.body;
      if (!books.length) out.errors.push('发现页未解析到书籍');
    } catch (e) {
      out.errors.push(`请求失败 ${url}: ${e.message}`);
    }
    return out;
  }

  buildExploreUrl(cat, page) {
    let url = String(cat || '');
    url = url.replace(/\{\{([\s\S]*?)\}\}/g, (m, expr) => {
      const e = expr.trim();
      try {
        const v = runJsRule(e, { page, baseUrl: this.baseUrl(), vars: this.vars, ctx: { page } });
        return v === undefined || v === null ? '' : String(v);
      } catch (err) {
        if (e === 'page') return String(page);
        return '';
      }
    });
    url = url.replace(/<,([^>]*)>/g, (m, inner) => (Number(page) <= 1 ? '' : inner));
    url = url.replace(/\{\{page\}\}/g, String(page));
    return this.resolveUrl(url);
  }

  /** 详情页 */
  async bookInfo(book, opts = {}) {
    const out = { ok: false, step: 'bookInfo', errors: [] };
    const url = book.bookUrl;
    if (!url) { out.errors.push('缺少书籍详情页 url'); return out; }
    try {
      const res = await this.requestPage(url, this.requestOptions());
      const json = this.isJsonContent(res, this.rule('ruleBookInfo', 'name'));
      const analyzer = this.makeAnalyzer(res.body, url, { book, json });
      if (json) analyzer.forcedJson = true;
      analyzer.setContent(res.body);
      const info = {};
      // init 规则
      const initRule = this.rule('ruleBookInfo', 'init');
      if (initRule) {
        try { this.makeAnalyzer(res.body, url, { book }).getString(initRule); } catch (e) { /* ignore */ }
      }
      for (const field of ['name', 'author', 'kind', 'lastChapter', 'intro', 'coverUrl', 'wordCount', 'tocUrl']) {
        const rule = this.rule('ruleBookInfo', field);
        if (!rule) continue;
        try {
          let v = String(analyzer.getString(rule) || '').trim();
          if (field === 'coverUrl') v = absUrl(url, v);
          if (field === 'tocUrl') v = absUrl(url, v);
          info[field] = v;
        } catch (e) {
          out.errors.push(`${field}: ${e.message}`);
        }
      }
      out.info = Object.assign({}, book, info);
      out.html = res.body;
      out.ok = !!(info.name || info.author || info.intro);
      if (!out.ok) out.errors.push('详情页未解析到任何字段');
    } catch (e) {
      out.errors.push(`请求失败 ${url}: ${e.message}`);
    }
    return out;
  }

  /** 目录 */
  async toc(book, sourceHtml, sourceUrl) {
    const out = { ok: false, step: 'toc', chapters: [], errors: [] };
    let url = book.tocUrl || book.bookUrl;
    if (!url) { out.errors.push('缺少目录页 url'); return out; }
    let body = '';
    let usedUrl = url;
    if (!book.tocUrl && sourceHtml && sourceUrl === url) body = sourceHtml;
    if (!body) {
      if (!book.tocUrl) {
        // 有些源目录在详情页，先尝试详情页
        try {
          const r = await this.requestPage(url, this.requestOptions());
          body = r.body;
          usedUrl = r.finalUrl || url;
        } catch (e) {
          out.errors.push(`请求失败 ${url}: ${e.message}`);
          return out;
        }
      } else {
        try {
          const r = await this.requestPage(url, this.requestOptions());
          body = r.body;
          usedUrl = r.finalUrl || url;
        } catch (e) {
          out.errors.push(`请求失败 ${url}: ${e.message}`);
          return out;
        }
      }
    }
    const listRule = this.rule('ruleToc', 'chapterList');
    if (!listRule) { out.errors.push('书源未配置 ruleToc.chapterList'); return out; }
    try {
      const analyzer = this.makeAnalyzer(body, usedUrl, { book });
      analyzer.setContent(body);
      let items = this.collectList(analyzer, listRule);
      const chapters = [];
      const seen = new Set();
      for (const item of items) {
        const a = this.makeAnalyzer(item, usedUrl, { book });
        if (typeof item === 'object' && item !== null && item.type === undefined) {
          a.forcedJson = true; a.json = item; a.doc = null; a.node = null;
        }
        let name = '', href = '';
        try { name = String(a.getString(this.rule('ruleToc', 'chapterName')) || '').trim(); } catch (e) { /* ignore */ }
        try {
          let raw = String(a.getString(this.rule('ruleToc', 'chapterUrl')) || '').trim();
          raw = this.extractUrl(raw);
          href = absUrl(usedUrl, raw);
        } catch (e) { /* ignore */ }
        if (!name && !href) continue;
        const key = name + '|' + href;
        if (seen.has(key)) continue;
        seen.add(key);
        chapters.push({ name, url: href, isVip: false, isVolume: false });
      }
      out.chapters = chapters;
      out.html = body;
      out.url = usedUrl;
      out.ok = chapters.length > 0;
      if (!out.ok) out.errors.push('未解析到章节列表');
    } catch (e) {
      out.errors.push(`目录解析失败: ${e.message}`);
    }
    return out;
  }

  /** 正文 */
  async content(book, chapter, opts = {}) {
    const out = { ok: false, step: 'content', text: '', errors: [], pages: [] };
    let url = chapter.url;
    if (!url) { out.errors.push('缺少章节 url'); return out; }
    const contentRule = this.rule('ruleContent', 'content');
    if (!contentRule) { out.errors.push('书源未配置 ruleContent.content'); return out; }
    let text = '';
    let maxPages = opts.maxPages || 8;
    const visited = new Set();
    let curUrl = url;
    let first = true;
    while (curUrl && maxPages-- > 0 && !visited.has(curUrl)) {
      visited.add(curUrl);
      let body;
      try {
        const res = await this.requestPage(curUrl, this.requestOptions());
        body = res.body;
        out.pages.push({ url: curUrl, length: body.length });
      } catch (e) {
        out.errors.push(`请求失败 ${curUrl}: ${e.message}`);
        break;
      }
      try {
        const analyzer = this.makeAnalyzer(body, curUrl, { book, chapter });
        analyzer.setContent(body);
        let piece = '';
        if (JS_PREFIX.test(contentRule.trim())) {
          const vals = analyzer.runJs(contentRule.replace(/^@js:/, '').replace(/^<js>/i, '').replace(/<\/js>$/i, ''), [body]);
          piece = Array.isArray(vals) ? vals.join('\n') : String(vals || '');
        } else {
          const values = analyzer.getStringList(contentRule);
          piece = values.join('\n');
        }
        // 正文里的实体字符（&nbsp; 等）需要解码后交给 Legado
        if (/&[a-zA-Z#][\w]*;/.test(piece)) piece = decodeEntities(piece);
        // 去掉标题重复
        text += (text ? '\n' : '') + cleanText(piece);
        if (first) {
          const titleRule = this.rule('ruleContent', 'title');
          if (titleRule) {
            try { out.title = analyzer.getString(titleRule); } catch (e) { /* ignore */ }
          }
          first = false;
        }
        const nextRule = this.rule('ruleContent', 'nextContentUrl');
        if (!nextRule) break;
        let next = '';
        try {
          const raw = String(analyzer.getString(nextRule) || '').trim();
          next = absUrl(curUrl, this.extractUrl(raw));
        } catch (e) { next = ''; }
        if (!next || next === curUrl) break;
        curUrl = next;
      } catch (e) {
        out.errors.push(`正文解析失败: ${e.message}`);
        break;
      }
    }
    text = cleanText(text);
    out.text = text;
    out.length = text.length;
    out.ok = text.length > 0;
    if (!out.ok) out.errors.push('未解析到正文');
    // 疑似反爬/加密判定
    out.suspicious = /[锟斤拷]|(\ufffd){2,}/.test(text);
    return out;
  }

  /** 完整校验：搜索 -> 详情 -> 目录 -> 正文 */
  async validate(key, opts = {}) {
    const report = {
      source: this.source.bookSourceName || this.source.bookSourceUrl,
      key,
      steps: {},
      ok: false,
      score: 0,
      issues: [],
    };
    const search = await this.search(key, 1);
    report.steps.search = {
      ok: search.ok, count: search.books.length,
      urls: search.urls, errors: search.errors,
      sample: search.books.slice(0, 3).map((b) => ({
        name: truncate(b.name, 40), author: truncate(b.author, 20), bookUrl: b.bookUrl,
      })),
    };
    if (!search.ok) {
      report.issues.push('搜索失败: ' + (search.errors[0] || '未知原因'));
      return report;
    }
    const book = search.books[0];
    const info = await this.bookInfo(book);
    report.steps.bookInfo = {
      ok: info.ok, errors: info.errors,
      info: info.info ? {
        name: truncate(info.info.name, 40), author: truncate(info.info.author, 20),
        coverUrl: truncate(info.info.coverUrl, 80), intro: truncate(info.info.intro, 60),
        kind: truncate(info.info.kind, 30), tocUrl: truncate(info.info.tocUrl, 80),
      } : null,
    };
    const merged = Object.assign({}, book, info.info || {});
    const toc = await this.toc(merged, info.html, info.info && info.info.tocUrl ? undefined : undefined);
    report.steps.toc = {
      ok: toc.ok, count: toc.chapters.length, errors: toc.errors,
      sample: toc.chapters.slice(0, 5).map((c) => truncate(c.name, 30)),
    };
    if (toc.ok && toc.chapters.length) {
      const chapter = toc.chapters[Math.min(1, toc.chapters.length - 1)];
      const content = await this.content(merged, chapter, { maxPages: opts.maxPages || 3 });
      report.steps.content = {
        ok: content.ok, length: content.length, errors: content.errors,
        preview: truncate(content.text, 120), suspicious: content.suspicious,
      };
    } else {
      report.steps.content = { ok: false, errors: ['目录为空，跳过正文'] };
    }
    const s = report.steps;
    let score = 0;
    if (s.search.ok) score += 25;
    if (s.bookInfo.ok) score += 15;
    if (s.toc.ok) score += 25;
    if (s.content && s.content.ok) score += 35;
    report.score = score;
    report.ok = !!(s.search.ok && s.toc.ok && s.content && s.content.ok);
    if (!report.ok) {
      for (const name of ['search', 'bookInfo', 'toc', 'content']) {
        const st = s[name];
        if (st && !st.ok && st.errors && st.errors.length) report.issues.push(`${name}: ${st.errors[0]}`);
      }
    }
    report.logs = this.logs;
    return report;
  }
}

function cleanText(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function truncate(s, n) {
  const v = String(s === undefined || s === null ? '' : s);
  return v.length > n ? v.slice(0, n) + '…' : v;
}

function splitLines(s) {
  return String(s || '').split(/\r?\n/).filter((x) => x.trim());
}

module.exports = { SourceSession, cleanText, truncate };
