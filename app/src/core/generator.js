'use strict';
/**
 * 自动生成书源：输入一个网址，嗅探站点结构并生成 Legado 书源，然后自测打分。
 */

const { parseHtml } = require('./dom');
const { selectAll } = require('./selector');
const { AnalyzeRule } = require('./rule');
const { HttpClient } = require('./http');
const { SourceSession } = require('./session');
const { absUrl, normalizeSiteUrl } = require('./urlutil');
const detect = require('./detect');
const { needsJsRender } = require('./render');

const COMMON_SEARCH_PATTERNS = [
  '{base}/search.php?q={key}&p={page}',
  '{base}/search.php?keyword={key}&page={page}',
  '{base}/search.php?searchkey={key}&page={page}',
  '{base}/search.php?searchkey={key}',
  '{base}/search?q={key}&page={page}',
  '{base}/search?keyword={key}&page={page}',
  '{base}/search?key={key}&page={page}',
  '{base}/search?wd={key}&page={page}',
  '{base}/s?q={key}&page={page}',
  '{base}/so.php?q={key}&p={page}',
  '{base}/index.php/search?key={key}&page={page}',
  '{base}/e/search/index.php',
  '{base}/modules/article/search.php?searchkey={key}',
  '{base}/search.html?key={key}&page={page}',
  '{base}/search/{key}?page={page}',
  '{base}/index.php?s=search&key={key}&page={page}',
  '{base}/index.php?c=search&key={key}&page={page}',
  '{base}/searchbook.php?key={key}&page={page}',
  '{base}/plus/search.php?kwtype=0&q={key}&page={page}',
  '{base}/search/index.html?key={key}&page={page}',
  '{base}/search/?q={key}&page={page}',
  '{base}/s.php?q={key}&page={page}',
  '{base}/search-{key}-{page}.html',
  '{base}/xiaoshuo/search_{key}_{page}.html',
];

const DEFAULT_TEST_KEY = '斗破苍穹';

/** 常见搜索入口的 GET 探测列表（包含 CMS 专用路径） */
const EXTRA_GET_PATTERNS = [
  '{base}/e/search/?keyboard={key}&page={page}',
  '{base}/e/search/index.php?keyboard={key}&page={page}',
  '{base}/index.php?m=search&key={key}&page={page}',
  '{base}/search.php?keyword={key}',
  '{base}/search/?keyword={key}&page={page}',
];

class SourceGenerator {
  constructor(opts = {}) {
    this.http = opts.http || new HttpClient({ timeout: opts.timeout || 20000, log: opts.log });
    this.log = opts.log || (() => {});
    this.testKey = opts.testKey || DEFAULT_TEST_KEY;
    this.onProgress = opts.onProgress || (() => {});
    // 渲染兜底：renderer 由 Electron 主进程注入；useRender 默认开（没有 renderer 时自动无效）
    this.renderer = opts.renderer || null;
    this.useRender = opts.useRender !== false;
    this.renderStats = { attempted: 0, succeeded: 0, reasons: [] };
  }

  get renderAvailable() {
    return !!(this.renderer && this.useRender);
  }

  /** 抓取单个页面：必要时回退到 JS 渲染 */
  async fetchPage(url, options = {}) {
    const res = await this.http.request(url, options);
    if (!this.renderAvailable || options.noRender) return res;
    if (options.forceRender) {
      const r = await this.renderWith(url, options);
      return r || res;
    }
    const verdict = needsJsRender(res.body, options.renderOptions);
    if (!verdict.needed) return res;
    this.log(`[render] ${verdict.reason}，改用浏览器渲染 ${url}`);
    const rendered = await this.renderWith(url, options);
    if (rendered) {
      this.renderStats.attempted++;
      this.renderStats.succeeded++;
      this.renderStats.reasons.push(verdict.reason);
      rendered.renderReason = verdict.reason;
      return rendered;
    }
    this.renderStats.attempted++;
    this.renderStats.reasons.push(verdict.reason + '（渲染未成功）');
    return res;
  }

  /** 调渲染器，转成与 http.request 兼容的结构 */
  async renderWith(url, options = {}) {
    try {
      const out = await this.renderer.render(url, {
        waitMs: options.waitMs || 1500,
        timeout: options.timeout || 20000,
        headers: options.headers,
      });
      if (!out || typeof out.body !== 'string' || !out.body) return null;
      return {
        status: out.status || 200,
        headers: out.headers || {},
        charset: 'utf-8',
        body: out.body,
        buffer: Buffer.from(out.body, 'utf8'),
        finalUrl: out.finalUrl || url,
        url: out.finalUrl || url,
        rendered: true,
      };
    } catch (e) {
      this.log(`[render] 渲染失败：${e.message}`);
      return null;
    }
  }

  progress(stage, message, extra) {
    this.onProgress(Object.assign({ stage, message }, extra || {}));
    this.log(`[${stage}] ${message}`);
  }

  /** 主流程 */
  async generate(inputUrl, opts = {}) {
    const testKey = opts.testKey || this.testKey;
    const result = {
      inputUrl,
      siteUrl: '',
      name: '',
      type: 'html',
      ok: false,
      candidates: [],
      source: null,
      validation: null,
      notes: [],
      steps: [],
    };
    const siteUrl = normalizeSiteUrl(inputUrl);
    result.siteUrl = siteUrl;
    this.progress('fetch', `抓取首页 ${siteUrl}`);
    const homeRes = await this.fetchHomeResilient(siteUrl);
    if (!homeRes) {
      result.notes.push('首页抓取失败，请检查网址或网络（部分站点需要 https / 需要代理，或已启用 Cloudflare 防护）');
      return result;
    }
    const home = homeRes.res;
    result.siteUrl = homeRes.siteUrl;
    const effectiveSite = homeRes.siteUrl;
    const doc = parseHtml(home.body);
    const title = (selectAll(doc, 'title')[0] || { text: '' }).text || '';
    result.name = cleanSiteName(title, effectiveSite);
    result.homeStatus = home.status;
    result.homeLength = home.body.length;
    result.rendered = !!home.rendered;
    this.progress('detect', `站点标题：${title.slice(0, 60)}${home.rendered ? '（已用浏览器渲染）' : ''}`);

    // 1) 搜索能力
    const search = await this.detectSearch(effectiveSite, doc, testKey, home.body);
    result.steps.push({ step: 'search', ok: !!search, info: search ? {
      url: search.url, kind: search.kind, count: search.count, method: search.method,
    } : null });
    if (!search) {
      result.notes.push('未能自动找到可用的搜索入口，将只生成“发现页/详情页”规则，请人工补充 searchUrl');
    }

    // 2) 书籍列表规则
    let listInfo = null;
    if (search && search.html) {
      listInfo = await this.detectBookList(search, effectiveSite, testKey);
    }
    if (!listInfo) {
      // 退回首页嗅探
      listInfo = this.pickStaticList(home.body, effectiveSite);
      if (listInfo) {
        result.notes.push('搜索页未解析出书籍列表，使用首页结构推断（发现页规则可参考）');
      }
    }
    result.steps.push({ step: 'bookList', ok: !!listInfo, info: listInfo ? { selector: listInfo.selector, count: listInfo.count } : null });

    // 3) 书籍 url 规则
    let bookUrlRule = null;
    if (listInfo) {
      bookUrlRule = this.detectBookUrlRule(listInfo, effectiveSite);
    }

    // 4) 详情页 + 目录 + 正文（用第一本书自测）
    let bookInfoRules = null;
    let tocRules = null;
    let contentRules = null;
    if (listInfo && bookUrlRule) {
      const first = listInfo.sampleBookUrls && listInfo.sampleBookUrls[0];
      if (first) {
        this.progress('detail', `分析详情页 ${first}`);
        bookInfoRules = await this.detectBookInfo(first, effectiveSite);
        const toc = await this.detectToc(first, effectiveSite);
        tocRules = toc.rules;
        if (toc.chapterUrl) {
          this.progress('content', `分析正文页 ${toc.chapterUrl}`);
          contentRules = await this.detectContent(toc.chapterUrl, effectiveSite);
        }
        result.steps.push({ step: 'bookInfo', ok: !!bookInfoRules, info: bookInfoRules });
        result.steps.push({ step: 'toc', ok: !!tocRules, info: tocRules });
        result.steps.push({ step: 'content', ok: !!contentRules, info: contentRules });
      }
    }

    // 5) 组装书源
    const source = this.assemble({
      siteUrl: effectiveSite,
      name: result.name,
      search,
      listInfo,
      bookUrlRule,
      bookInfoRules,
      tocRules,
      contentRules,
    });
    result.source = source;
    result.renderStats = this.renderStats;

    // 6) 用引擎自测
    if (source.searchUrl) {
      this.progress('validate', '使用规则引擎自测（搜索→详情→目录→正文）');
      const session = new SourceSession(source, { timeout: 20000 });
      result.validation = await session.validate(testKey, { maxPages: 2 });
      result.ok = !!result.validation.ok;
    } else {
      result.notes.push('无 searchUrl，跳过完整校验');
    }
    return result;
  }

  async fetchSafe(url, options) {
    try {
      if (options && options.method && options.method !== 'GET') {
        return await this.http.request(url, options);
      }
      return await this.fetchPage(url, options || {});
    } catch (e) {
      this.log(`抓取失败 ${url}: ${e.message}`);
      return null;
    }
  }

  /**
   * 首页抓取失败时依次尝试：https、www 前缀、http、带常见 UA/无 UA。
   * 返回 { res, siteUrl } 或 null。
   */
  async fetchHomeResilient(siteUrl) {
    const tries = [];
    const push = (u, opts) => { if (u && !tries.some((t) => t.u === u)) tries.push({ u, opts }); };
    push(siteUrl);
    const parsed = safeParse(siteUrl);
    if (parsed) {
      const host = parsed.hostname;
      const bare = host.replace(/^www\./, '');
      const withWww = host.startsWith('www.') ? host : 'www.' + host;
      const alts = [bare, withWww];
      for (const h of alts) {
        push(`${parsed.protocol}//${h}${parsed.pathname}`);
        push(`${parsed.protocol === 'https:' ? 'http:' : 'https:'}//${h}${parsed.pathname}`);
      }
    }
    push(siteUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' } });
    for (const t of tries) {
      const res = await this.fetchSafe(t.u, t.opts);
      if (res && res.status < 400 && res.body.length > 200) {
        return { res, siteUrl: t.u.replace(/\/+$/, '') };
      }
    }
    return null;
  }

  // ---------------- 搜索探测 ----------------

  async detectSearch(siteUrl, doc, key, homeBody) {
    const candidates = [];
    // 站点自带表单
    const forms = detect.findSearchForms(doc, siteUrl);
    for (const f of forms) {
      if (isThirdPartySearch(f.action, siteUrl)) continue;
      const textParam = f.params.find((p) => /q|key|kw|wd|search|word/i.test(p.name)) || f.params.find((p) => p.type === 'text') || f.params[0];
      if (!textParam) continue;
      if (f.method === 'POST') {
        // 带上表单里的隐藏字段（很多 CMS 需要 show/classid 等参数）
        const parts = [`${textParam.name}={{key}}`];
        for (const p of f.params) {
          if (p === textParam) continue;
          if (p.type === 'hidden' && p.value) parts.push(`${p.name}=${encodeURIComponent(p.value)}`);
        }
        candidates.push({
          url: f.action,
          method: 'POST',
          kind: 'form-post',
          body: parts.join('&'),
          raw: f,
        });
        // 同一 action 也常支持 GET（如 EmpireCMS 的 /e/search/）
        candidates.push({
          url: `${f.action}?${textParam.name}={{key}}&page={{page}}`,
          method: 'GET',
          kind: 'form-get',
          param: textParam.name,
          raw: f,
        });
      } else {
        candidates.push({
          url: `${f.action}?${textParam.name}={{key}}&page={{page}}`,
          method: 'GET',
          kind: 'form-get',
          param: textParam.name,
          raw: f,
        });
      }
    }
    // 常见路径
    const base = siteUrl.replace(/\/+$/, '');
    for (const p of COMMON_SEARCH_PATTERNS.concat(EXTRA_GET_PATTERNS)) {
      candidates.push({ url: p.replace('{base}', base), kind: 'guess' });
    }
    const seen = new Set();
    for (const c of candidates) {
      if (isThirdPartySearch(c.url, siteUrl)) continue;
      const testUrl = this.buildTestUrl(c, key, 1);
      if (!testUrl || seen.has(testUrl)) continue;
      seen.add(testUrl);
      const res = await this.fetchSafe(testUrl, c.method === 'POST' ? { method: 'POST', body: this.buildTestBody(c, key) } : undefined);
      if (!res || res.status >= 400) continue;
      const body = res.body;
      if (body.length < 100) continue;
      // soft-404：返回的其实是首页本身（常见于路径型搜索），跳过
      if (homeBody && isSamePage(body, homeBody)) continue;
      // JSON 接口
      const trimmed = body.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        let json;
        try { json = JSON.parse(trimmed); } catch (e) { json = null; }
        if (json) {
          const lists = detect.findJsonListCandidates(json);
          if (lists.length) {
            return {
              url: c.url, kind: 'json', method: c.method || 'GET', body: c.body,
              jsonPath: lists[0].path, keys: lists[0].keys, count: lists[0].count,
              json, html: body, param: c.param,
            };
          }
        }
      }
      const list = this.detectBookListFromHtml(body, testUrl);
      if (list) {
        return {
          url: c.url, kind: 'html', method: c.method || 'GET', body: c.body,
          count: list.count, list, html: body, param: c.param,
        };
      }
    }
    return null;
  }

  buildTestUrl(c, key, page) {
    let u = c.url;
    if (c.method === 'POST') return u;
    return u.replace(/\{\{key\}\}/g, encodeURIComponent(key)).replace(/\{\{page\}\}/g, String(page));
  }

  buildTestBody(c, key) {
    return String(c.body || '').replace(/\{\{key\}\}/g, encodeURIComponent(key)).replace(/\{\{page\}\}/g, '1');
  }

  detectBookListFromHtml(body, url) {
    const doc = parseHtml(body);
    const cands = detect.findListCandidates(doc, { minItems: 2 });
    let best = null;
    for (const c of cands) {
      const urls = this.itemsToBookUrls(c.items, url);
      // 要求绝大多数条目都带链接，避免选到栏目/导航区块
      if (urls.length < Math.max(2, Math.ceil(c.items.length * 0.6))) continue;
      // 链接像书籍详情页的候选优先
      const bookish = urls.filter((u) => detect.isBookLikeHref(u)).length / urls.length;
      const score = (c.score || 0) + bookish * 4;
      if (!best || score > best.score2) {
        best = Object.assign({}, c, { sampleBookUrls: urls, html: body, doc, bookish, score2: score });
      }
    }
    return best;
  }

  itemsToBookUrls(items, pageUrl) {
    const out = [];
    for (const it of items) {
      const a = selectAll(it, 'a[href]')[0];
      if (!a) continue;
      const href = absUrl(pageUrl, a.attr('href'));
      if (/^https?:/i.test(href) && !/#/.test(href)) out.push(href);
    }
    return out;
  }

  /** 搜索页确定 bookList / 字段规则 */
  async detectBookList(search, siteUrl, key) {
    if (search.kind === 'json') {
      const itemPath = normalizeJsonPath(search.jsonPath);
      const fieldRules = detect.guessJsonFieldRules(search.keys);
      return {
        type: 'json',
        selector: itemPath,
        legadoSelector: itemPath,
        count: search.count,
        fields: fieldRules,
        sampleBookUrls: this.jsonBookUrls(search.json, search.jsonPath, search.url),
        doc: null,
        html: search.html,
      };
    }
    const doc = parseHtml(search.html);
    const cands = detect.findListCandidates(doc, { minItems: 2 });
    let best = null;
    for (const c of cands) {
      const urls = this.itemsToBookUrls(c.items, search.url);
      if (!urls.length) continue;
      if (urls.length < Math.max(2, Math.ceil(c.items.length * 0.6))) continue;
      const fields = this.detectItemFields(c.items, search.url);
      const bookish = urls.filter((u) => detect.isBookLikeHref(u)).length / urls.length;
      const score = c.score + urls.length / 10 + (fields.name ? 1 : 0) + (fields.bookUrl ? 1 : 0) + bookish * 4;
      if (!best || score > best.score2) {
        best = Object.assign({}, c, {
          type: 'html',
          fields,
          sampleBookUrls: urls,
          score2: score,
          bookish,
          html: search.html,
          doc,
        });
      }
    }
    return best;
  }

  jsonBookUrls(json, path, baseUrl) {
    let items = [];
    try {
      const { jsonPathQuery } = require('./jsonpath');
      items = jsonPathQuery(json, path) || [];
    } catch (e) { items = []; }
    const out = [];
    for (const it of items.slice(0, 10)) {
      if (!it || typeof it !== 'object') continue;
      const urlKey = Object.keys(it).find((k) => /^(url|link|href|bookurl|book_url)$/i.test(k)) || Object.keys(it).find((k) => /url|link/i.test(k));
      if (!urlKey) continue;
      const u = absUrl(baseUrl, it[urlKey]);
      if (u) out.push(u);
    }
    return out;
  }

  pickStaticList(body, siteUrl) {
    const doc = parseHtml(body);
    const info = this.detectBookListFromHtml(body, siteUrl);
    if (!info) return null;
    // 首页结构推断时也要给出字段规则
    info.fields = this.detectItemFields(info.items, siteUrl);
    return info;
  }

  /** 对列表项探测每个字段的规则 */
  detectItemFields(items, pageUrl) {
    const fields = {};
    if (!items.length) return fields;
    const { rules, details } = detect.probeFieldRules(items, pageUrl, AnalyzeRule, pageUrl);
    Object.assign(fields, rules);
    const urlProbe = detect.probeBookUrlRule(items, pageUrl, AnalyzeRule);
    if (urlProbe) fields.bookUrl = urlProbe.rule;
    if (!fields.name) fields.name = 'a[href].0@text';
    if (!fields.bookUrl) fields.bookUrl = 'a[href].0@href';
    if (fields.name && /^\[.+\]/.test((details.name && details.name.sample[0]) || '')) {
      fields.name = `${fields.name}##\\[.+?\\]`;
    }
    // 去掉 “作者：” 之类的标签前缀
    if (fields.author) fields.author = `${fields.author}##^(?:作者|作\\s*者)[:：]\\s*`;
    if (fields.lastChapter) fields.lastChapter = `${fields.lastChapter}##^(?:最新章节|最新)[:：]\\s*`;
    if (fields.kind) fields.kind = `${fields.kind}##^(?:状态|类型|分类)[:：]\\s*`;
    this.fieldDetails = details;
    return fields;
  }

  /** 从列表项里推 bookUrl 规则 */
  detectBookUrlRule(listInfo, siteUrl) {
    const fields = listInfo && listInfo.fields;
    if (fields && fields.bookUrl) return fields.bookUrl;
    if (listInfo && listInfo.type === 'json') return '';
    return toLegadoRule('a[href]', 'href');
  }

  // ---------------- 详情页 ----------------

  async detectBookInfo(bookUrl, siteUrl) {
    const res = await this.fetchSafe(bookUrl);
    if (!res) return null;
    const doc = parseHtml(res.body);
    const rules = {};
    // 书名：h1 / meta og:novel:book_name
    const title = selectAll(doc, 'h1')[0] || selectAll(doc, '.bookname h1')[0];
    if (title && title.text.trim()) rules.name = 'h1@text';
    else {
      const meta = selectAll(doc, 'meta[property="og:novel:book_name"]')[0];
      if (meta) rules.name = 'meta[property="og:novel:book_name"]@content';
    }
    const authorMeta = selectAll(doc, 'meta[property="og:novel:author"]')[0];
    const authorEl = selectAll(doc, '#info p, .bookinfo p, .info p, .book-info p, .bookinfo, #info')[0];
    if (authorMeta) rules.author = 'meta[property="og:novel:author"]@content';
    else if (authorEl) {
      const m = authorEl.text.match(/(?:作\s*者|作者)[:：]\s*([^\s|,，]+)/);
      if (m) rules.author = `#info@text##.*作者[:：]\\s*([^\\s|,，]+).*##$1###`;
    }
    const cover = selectAll(doc, 'meta[property="og:image"]')[0] || selectAll(doc, '#fmimg img, .cover img, .bookimg img, .book-img img, .book_cover img, img')[0];
    if (cover) {
      rules.coverUrl = cover.tagName === 'meta' ? 'meta[property="og:image"]@content' : firstImgRule(doc, bookUrl);
    }
    const intro = selectAll(doc, '#intro, .intro, .bookintro, #bookIntro, .book_intro, .desc, #bookintro')[0];
    if (intro) rules.intro = toLegadoRule(shortSelector(doc, intro), 'text');
    const kindMeta = selectAll(doc, 'meta[property="og:novel:category"]')[0];
    if (kindMeta) rules.kind = 'meta[property="og:novel:category"]@content';
    const lastMeta = selectAll(doc, 'meta[property="og:novel:latest_chapter_name"]')[0];
    if (lastMeta) rules.lastChapter = 'meta[property="og:novel:latest_chapter_name"]@content';
    rules.tocUrl = '';
    return rules;
  }

  // ---------------- 目录 ----------------

  async detectToc(bookUrl, siteUrl) {
    const out = { rules: null, chapterUrl: null, sourceUrl: bookUrl, candidates: [] };
    const res = await this.fetchSafe(bookUrl);
    if (!res) return out;
    const doc = parseHtml(res.body);
    let cands = detect.findChapterListCandidates(doc, { minItems: 3 });
    // 若详情页无目录，尝试常见目录页
    if (!cands.length) {
      const guesses = [
        trailingSlash(bookUrl) + 'index.html',
        trailingSlash(bookUrl) + 'list.html',
        trailingSlash(bookUrl) + 'all.html',
        trailingSlash(bookUrl) + 'index_1.html',
        trailingSlash(bookUrl) + 'chapters.html',
      ];
      for (const g of guesses) {
        const r = await this.fetchSafe(g);
        if (!r) continue;
        const d2 = parseHtml(r.body);
        const c2 = detect.findChapterListCandidates(d2, { minItems: 5 });
        if (c2.length) {
          cands = c2;
          out.tocUrl = g;
          out.doc = d2;
          break;
        }
      }
    }
    if (!cands.length) return out;
    const best = cands[0];
    out.candidates = cands.map((c) => ({ selector: c.selector, count: c.count, score: Number(c.chapterScore.toFixed(3)) }));
    const nameRule = pickChapterNameRule(best.items);
    const urlRule = pickChapterUrlRule(best.items);
    out.rules = {
      chapterList: best.legadoSelector,
      chapterName: nameRule,
      chapterUrl: urlRule,
    };
    if (out.tocUrl) out.rules._tocUrl = out.tocUrl;
    const firstLink = selectAll(best.items[0], 'a[href]')[0];
    if (firstLink) out.chapterUrl = absUrl(bookUrl, firstLink.attr('href'));
    out.count = best.count;
    return out;
  }

  // ---------------- 正文 ----------------

  async detectContent(chapterUrl, siteUrl) {
    const res = await this.fetchSafe(chapterUrl);
    if (!res) return null;
    const doc = parseHtml(res.body);
    const cands = detect.findContentCandidates(doc, { minLength: 200 });
    if (!cands.length) return null;
    const best = cands[0];
    const rules = {
      content: `@css:${best.selector}`,
    };
    // 尝试更“干净”的选择器（常见 id/class）
    const clean = pickCleanContentSelector(doc, chapterUrl);
    if (clean) rules.content = clean;
    // 下一页
    const next = findNextPageRule(doc, chapterUrl);
    if (next) rules.nextContentUrl = next;
    rules._candidates = cands.map((c) => ({ selector: c.selector, textLength: c.textLength, score: Number(c.score.toFixed(1)) }));
    rules._preview = best.preview;
    return rules;
  }

  // ---------------- 组装 ----------------

  assemble(parts) {
    const { siteUrl, name, search, listInfo, bookUrlRule, bookInfoRules, tocRules, contentRules } = parts;
    const source = {
      bookSourceComment: `由 书源工作台 自动生成 · ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`,
      bookSourceGroup: '自动生成',
      bookSourceName: name || siteUrl,
      bookSourceType: 0,
      bookSourceUrl: siteUrl,
      customOrder: 0,
      enabled: true,
      enabledCookieJar: false,
      enabledExplore: false,
      exploreUrl: '',
      header: '',
      lastUpdateTime: Date.now(),
      respondTime: 2000,
      ruleBookInfo: bookInfoRules || {},
      ruleContent: contentRules ? stripInternal(contentRules) : {},
      ruleExplore: {},
      ruleSearch: {},
      ruleToc: tocRules ? stripInternal(tocRules) : {},
      searchUrl: '',
      weight: 0,
    };
    if (search) {
      if (search.kind === 'json') {
        source.searchUrl = jsonSearchUrl(search);
        source.ruleSearch = Object.assign({
          bookList: normalizeJsonPath(search.jsonPath),
        }, listInfo && listInfo.fields ? listInfo.fields : {});
      } else {
        source.searchUrl = search.url;
        if (listInfo) {
          source.ruleSearch = Object.assign({ bookList: listInfo.legadoSelector }, listInfo.fields || {});
        }
      }
    }
    if (listInfo && listInfo.type === 'json' && listInfo.fields) {
      source.ruleSearch = Object.assign({ bookList: listInfo.selector }, listInfo.fields);
    }
    if (tocRules && tocRules._tocUrl) {
      source.ruleBookInfo = Object.assign({}, source.ruleBookInfo, { tocUrl: tocRules._tocUrl });
    }
    return source;
  }
}

// ---------------- 小工具 ----------------

function stripInternal(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith('_')) continue;
    out[k] = v;
  }
  return out;
}

function cleanSiteName(title, siteUrl) {
  let name = String(title || '').split(/[-_|–—]/)[0].trim();
  name = name.replace(/小说|阅读网|最新章节|免费阅读|全文阅读/g, '').trim();
  if (!name) {
    try { name = new URL(siteUrl).hostname; } catch (e) { name = siteUrl; }
  }
  return name.slice(0, 20);
}

function toLegadoRule(selector, field) {
  const sel = String(selector || '').trim();
  if (!sel) return '';
  if (sel.startsWith('@css:')) {
    return field === 'text' ? sel : `${sel}@${field}`;
  }
  // 用 CSS 形式更稳：@css:...@text
  const op = field === 'href' ? 'href' : (field === 'src' ? 'src' : 'text');
  if (/[[#\s>.:]/.test(sel)) {
    return `@css:${sel}@${op}`;
  }
  return `${sel}@${op}`;
}

function firstImgRule(doc, baseUrl) {
  const imgs = selectAll(doc, 'img');
  for (const img of imgs) {
    const src = img.attr('src') || img.attr('data-src') || '';
    if (/cover|book|novel|\/\d+\/\d+\//i.test(src) || imgs.length <= 3) {
      return '@css:img@src';
    }
  }
  return '@css:img@src';
}

function shortSelector(doc, el) {
  if (el.id) return `#${el.id}`;
  const classes = (el.classes || []).filter((c) => !/^\d/.test(c));
  if (classes.length) return `${el.tagName}.${classes[0]}`;
  return el.tagName;
}

function trailingSlash(u) {
  return String(u).endsWith('/') ? u : u + '/';
}

function safeParse(u) {
  try { return new URL(u); } catch (e) { return null; }
}

const THIRD_PARTY_SEARCH = /(baidu\.com|google\.|bing\.com|sogou\.com|so\.com|sm\.cn|yandex\.|duckduckgo\.)/i;

/** 排除站外/搜索引擎的“搜索”链接（很多站点底部挂着百度搜索框） */
function isThirdPartySearch(url, siteUrl) {
  if (!url) return true;
  if (/^javascript:/i.test(url)) return true;
  if (THIRD_PARTY_SEARCH.test(url)) return true;
  const a = safeParse(url);
  const b = safeParse(siteUrl);
  if (a && b) {
    const ha = a.hostname.replace(/^www\./, '');
    const hb = b.hostname.replace(/^www\./, '');
    if (ha !== hb && !ha.endsWith('.' + hb) && !hb.endsWith('.' + ha)) return true;
  }
  return false;
}

/** 判断两个页面是否基本相同（soft-404 检测） */
function isSamePage(a, b) {
  if (!a || !b) return false;
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  // 完全一致直接判定
  if (x === y) return true;
  const shorter = Math.min(x.length, y.length);
  const longer = Math.max(x.length, y.length);
  // 长度接近且抽样高度重合才算“同一页”
  if ((longer - shorter) / longer > 0.1) return false;
  const step = 80;
  let same = 0;
  let total = 0;
  for (let i = 0; i + step <= x.length; i += 400) {
    total++;
    if (y.includes(x.slice(i, i + step))) same++;
  }
  return total >= 8 && same / total > 0.95;
}

function normalizeJsonPath(p) {
  let path = String(p || '').trim();
  if (!path) return '';
  if (!path.startsWith('$')) path = '$' + (path.startsWith('.') ? '' : '.') + path;
  return path;
}

function jsonSearchUrl(search) {
  let url = search.url || '';
  if (search.body) {
    return `${url},{"method":"POST","body":${JSON.stringify(search.body)}}`;
  }
  if (!/\{\{key\}\}/.test(url)) {
    url += (url.includes('?') ? '&' : '?') + 'key={{key}}&page={{page}}';
  }
  return url;
}

function pickChapterNameRule(items) {
  const probes = ['a@text', 'dd a@text', 'li a@text', 'td a@text', 'a@title', 'span@text', 'a.0@text'];
  let best = null;
  const maxN = Math.min(items.length, 5);
  for (const p of probes) {
    const vals = [];
    for (const it of items.slice(0, maxN)) {
      let v = '';
      try {
        const a = new AnalyzeRule({ content: it });
        v = String(a.getString(p) || '').trim();
      } catch (e) { v = ''; }
      vals.push(v);
    }
    const cov = vals.filter(Boolean).length / maxN;
    const sensible = vals.filter((v) => v && v.length <= 40).length / maxN;
    if (cov < 0.6 || sensible < 0.6) continue;
    const score = cov * 2 + sensible * 2 - p.length * 0.01;
    if (!best || score > best.score) best = { rule: p, score };
  }
  return best ? best.rule : 'a@text';
}

function pickChapterUrlRule(items) {
  const probes = ['a@href', 'dd a@href', 'td a@href'];
  let best = null;
  const maxN = Math.min(items.length, 5);
  for (const p of probes) {
    const vals = [];
    for (const it of items.slice(0, maxN)) {
      let v = '';
      try {
        const a = new AnalyzeRule({ content: it });
        v = String(a.getString(p) || '').trim();
      } catch (e) { v = ''; }
      vals.push(v);
    }
    const cov = vals.filter((v) => v && !/^javascript:/i.test(v)).length / maxN;
    if (cov < 0.6) continue;
    if (!best || cov > best.cov) best = { rule: p, cov };
  }
  return best ? best.rule : 'a@href';
}

function pickCleanContentSelector(doc, baseUrl) {
  const ids = ['#content', '#chaptercontent', '#chapter-content', '#booktext', '#htmlContent', '#nr1',
    '#nr', '#txtContent', '#read-content', '.content', '.read-content', '.showtxt', '#BookText',
    '#chapter_content', '.yd_text2', '#content1', '.box_con #content'];
  for (const sel of ids) {
    const el = selectAll(doc, sel)[0];
    if (el) {
      const len = el.text.replace(/\s+/g, '').length;
      if (len > 200) return `@css:${sel}@html`;
    }
  }
  return null;
}

function findNextPageRule(doc, baseUrl) {
  const links = selectAll(doc, 'a[href]');
  for (const a of links) {
    const t = a.text.trim();
    if (/^(下一页|下一章|下页|下一节|next)$/i.test(t)) {
      const href = a.attr('href');
      if (href && !/#/.test(href)) return `text.${t}@href`;
    }
  }
  return null;
}

module.exports = { SourceGenerator, DEFAULT_TEST_KEY, COMMON_SEARCH_PATTERNS };
