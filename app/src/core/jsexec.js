'use strict';
/**
 * Legado 规则的 JavaScript 子集执行器。
 * 目标：让常见的书源 js 规则（jsoup 风格 result.select(...)、字符串处理、正则、简单循环）
 *      在 PC 端也能跑起来。无法识别的语法会抛出错误，由上层标记为“需人工处理”。
 *
 * 提供：result / baseUrl / src / book / chapter / title / key / page / cookie / cache / java 等
 */

const { parseHtml } = require('./dom');
const { selectAll } = require('./selector');

class JsUnsupported extends Error {
  constructor(msg) { super(msg); this.name = 'JsUnsupported'; }
}

// ---------------- jsoup 风格包装 ----------------

class JsoupElements {
  constructor(list) { this.list = list || []; }
  get length() { return this.list.length; }
  size() { return this.list.length; }
  get(i) { return wrap(this.list[i]); }
  first() { return wrap(this.list[0]); }
  last() { return wrap(this.list[this.list.length - 1]); }
  eq(i) { return wrap(this.list[i]); }
  toArray() { return this.list.map(wrap); }
  text() { return this.list.map((e) => (e && (e.text || e.data || ''))).join(' ').trim(); }
  html() { return this.list.map((e) => (e && e.type === 'element' ? e.innerHTML() : String(e && e.data || ''))).join('\n'); }
  outerHtml() { return this.list.map((e) => (e && e.toString ? e.toString() : String(e))).join('\n'); }
  each(fn) { this.list.forEach((e, i) => fn.call(wrap(e), i, wrap(e))); return this; }
  forEach(fn) { this.list.forEach((e, i) => fn(wrap(e), i)); return this; }
  map(fn) { return this.list.map((e, i) => fn(wrap(e), i)); }
  attr(name) { if (!this.list.length) return ''; const e = this.list[0]; return e && e.attr ? e.attr(name) : ''; }
  hasAttr(name) { if (!this.list.length) return false; const e = this.list[0]; return !!(e && e.hasAttr && e.hasAttr(name)); }
  select(sel) { const out = []; for (const e of this.list) if (e && e.type === 'element') out.push(...selectAll(e, sel)); return new JsoupElements(out); }
  isEmpty() { return this.list.length === 0; }
  toString() { return this.outerHtml(); }
  val() { return this.attr('value'); }
  not(sel) { return new JsoupElements(this.list.filter((e) => e && e.type === 'element' && !selectAll({ children: [e] }, sel).length)); }
}

function wrap(node) {
  if (node === undefined || node === null) return null;
  if (node instanceof JsoupElement || node instanceof JsoupElements) return node;
  if (node.type === 'text') return new JsoupElement(node);
  if (node.type === 'element') return new JsoupElement(node);
  if (node.type === 'document') return new JsoupElement(node.root);
  return node;
}

/**
 * 给元素套上 jsoup 风格对象，并让 String(obj) 得到“取值后的字符串”。
 * Legado 里 result 可能是节点，也可能是节点取出的文本/属性，书源两种写法都有。
 */
function wrapNodeValue(node, text) {
  const w = wrap(node);
  if (w && typeof w === 'object' && text !== undefined && text !== null) {
    try { w._value = String(text); } catch (e) { /* ignore */ }
    w.toString = function toString() { return String(this._value !== undefined ? this._value : (this.node ? this.node.text : '')); };
    w.valueOf = function valueOf() { return this.toString(); };
  }
  return w;
}

class JsoupElement {
  constructor(node) { this.node = node; }
  get type() { return this.node.type; }
  get tagName() { return this.node.tagName; }
  text() { return this.node.text; }
  ownText() { return this.node.ownText; }
  html() { return this.node.type === 'element' ? this.node.innerHTML() : (this.node.data || ''); }
  outerHtml() { return this.node.toString(); }
  attr(name) { return this.node.attr ? this.node.attr(name) : ''; }
  hasAttr(name) { return this.node.hasAttr ? this.node.hasAttr(name) : false; }
  val() { return this.attr('value'); }
  id() { return this.node.id || ''; }
  className() { return this.node.className || ''; }
  classNames() { return new Set(this.node.classes || []); }
  select(sel) { return new JsoupElements(selectAll(this.node, sel)); }
  children() { return new JsoupElements(this.node.children || []); }
  child(i) { return wrap((this.node.children || [])[i === undefined ? 0 : i]); }
  parent() { return wrap(this.node.parent); }
  parents() {
    const out = [];
    let p = this.node.parent;
    while (p) { out.push(p); p = p.parent; }
    return new JsoupElements(out);
  }
  nextElementSibling() { return wrap(this.node.nextElementSibling); }
  previousElementSibling() { return wrap(this.node.previousElementSibling); }
  siblingElements() {
    if (!this.node.parent) return new JsoupElements([]);
    return new JsoupElements(this.node.parent.children.filter((c) => c !== this.node));
  }
  elementSiblingIndex() {
    if (!this.node.parent) return 0;
    return this.node.parent.children.indexOf(this.node);
  }
  get elements() { return new JsoupElements(this.node.children || []); }
  get allElements() {
    const out = [];
    const walk = (n) => { for (const c of n.children || []) { out.push(c); walk(c); } };
    walk(this.node);
    return new JsoupElements(out);
  }
  remove() { if (this.node.parent) this.node.parent.childNodes = this.node.parent.childNodes.filter((c) => c !== this.node); return this; }
  unwrap() { return this; }
  before() { return this; }
  after() { return this; }
  toString() { return this.outerHtml(); }
}

// ---------------- Jsoup 静态 API ----------------

function JsoupParse(html) {
  const doc = parseHtml(typeof html === 'string' ? html : String(html && html.html ? html.html() : html));
  return new JsoupElement(doc.root);
}

// ---------------- 字符串 / 工具函数 ----------------

function base64Decode(str) { return Buffer.from(String(str), 'base64').toString('binary'); }
function base64Encode(str) { return Buffer.from(String(str), 'binary').toString('base64'); }
function md5(str) { return require('crypto').createHash('md5').update(String(str), 'utf8').digest('hex'); }
function encodeURICompat(str) { return encodeURIComponent(String(str)); }
function htmlFormat(str) {
  return String(str)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
function timeFormat(ts) {
  const d = new Date(Number(ts));
  if (Number.isNaN(d.getTime())) return String(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function makeJavaShim(ctx) {
  const logs = [];
  const java = {
    log: (msg) => { logs.push(String(msg)); if (ctx.onLog) ctx.onLog(String(msg)); },
    ajax: (url) => {
      const http = require('./http');
      return http.fetchTextSyncish ? http.fetchTextSyncish(url, ctx) : '';
    },
    base64Decode,
    base64Encode,
    md5Encode: md5,
    md5Encode16: (s) => md5(s).slice(8, 24),
    encodeURI: encodeURICompat,
    htmlFormat,
    timeFormat,
    getString: (rule) => (ctx.analyzer ? ctx.analyzer.getString(rule) : ''),
    getStringList: (rule) => (ctx.analyzer ? ctx.analyzer.getStringList(rule) : []),
    getElements: (rule) => (ctx.analyzer ? ctx.analyzer.getElements(rule) : []),
    setContent: (content, baseUrl) => { if (ctx.analyzer) ctx.analyzer.setContent(content, baseUrl); return ctx.analyzer; },
    // @put/@get
    put: (k, v) => { ctx.vars[k] = v; },
    get: (k) => ctx.vars[k],
    _logs: logs,
  };
  return java;
}

// ---------------- 执行 ----------------

function buildScope(ctx) {
  const vars = ctx.vars || Object.create(null);
  const java = makeJavaShim(ctx);
  const bookObj = makeBookShim(ctx);
  const chapterObj = ctx.chapter || {};
  const scope = {
    result: ctx.result,
    baseUrl: ctx.baseUrl || '',
    src: ctx.src || '',
    title: ctx.title || '',
    key: ctx.key !== undefined ? ctx.key : (ctx.ctx && ctx.ctx.key),
    page: ctx.page !== undefined ? ctx.page : (ctx.ctx && ctx.ctx.page),
    book: bookObj,
    chapter: chapterObj,
    java,
    Packages: {
      org: { jsoup: { Jsoup: { parse: JsoupParse } } },
      java: { lang: { String: String, Integer: Number, StringBuilder: StringBuilder } },
    },
    org: { jsoup: { Jsoup: { parse: JsoupParse } } },
    Jsoup: { parse: JsoupParse },
    cookie: {
      getCookie: () => (ctx.cookie || ''),
      setCookie: () => {},
      removeCookie: () => {},
    },
    cache: {
      get: (k) => vars['__cache_' + k],
      put: (k, v) => { vars['__cache_' + k] = v; },
      delete: (k) => { delete vars['__cache_' + k]; },
    },
    String,
    Number,
    Boolean,
    JSON,
    Math,
    Date,
    RegExp,
    Array,
    Object,
    parseInt,
    parseFloat,
    isNaN,
    encodeURIComponent,
    decodeURIComponent,
    encodeURI,
    decodeURI,
    atob: (s) => Buffer.from(String(s), 'base64').toString('binary'),
    btoa: (s) => Buffer.from(String(s), 'binary').toString('base64'),
    java_put: (k, v) => { vars[k] = v; },
    java_get: (k) => vars[k],
    ...vars,
  };
  scope.global = scope;
  return scope;
}

class StringBuilder {
  constructor() { this.parts = []; }
  append(s) { this.parts.push(String(s)); return this; }
  toString() { return this.parts.join(''); }
}

function makeBookShim(ctx) {
  const b = ctx.book || {};
  const book = Object.assign(Object.create(null), b);
  book.name = b.name || '';
  book.author = b.author || '';
  book.bookUrl = b.bookUrl || ctx.baseUrl || '';
  book.setType = (t) => { book.type = t; };
  book.getType = () => book.type;
  book.setVariable = (k, v) => { book[k] = v; };
  book.getVariable = (k) => book[k];
  return book;
}

/**
 * 执行 js 规则片段。
 * 片段可能是：
 *   1) 单个表达式： result.vod_name || ''
 *   2) 语句块（以 var/let/const/if/for/return 开头，或以 ; 结束）
 * 返回值为最终结果（语句块取最后一个表达式的值，或 return 的值）。
 */
function runJsRule(code, ctx = {}) {
  let src = String(code == null ? '' : code).trim();
  if (!src) return undefined;
  // 去掉 <js> 包裹
  src = src.replace(/^<js>/i, '').replace(/<\/js>$/i, '').trim();
  const isBlock = /^(var|let|const|if|for|while|switch|try|function|return|\/\/|\/\*)/.test(src)
    || src.includes('\n') || src.includes(';');
  let full;
  if (isBlock) {
    const hasReturn = /(^|[^.\w])return\b/.test(src);
    if (hasReturn) full = src;
    else {
      // 取最后一条“完整”语句作为返回值：从末尾往前找第一条括号配平的语句，
      // 这样 try{...}catch{...} 这种结构不会被拆散
      const stmts = splitStatements(src);
      let last = null;
      for (let i = stmts.length - 1; i >= 0; i--) {
        const s = stmts[i].text;
        // 声明语句不能直接放在括号里求值；块语句（try/if/for...）也不是表达式
        if (/\b(var|let|const|function|return)\b/.test(s)) continue;
        if (/^(?:try|if|for|while|switch|do|else|\{)/.test(s)) continue;
        if (isCompleteStatement(s)) { last = stmts[i]; break; }
      }
      if (last) {
        full = src.slice(0, last.start) + `\n;__RESULT__ = (${last.text});`;
      } else if (/__RESULT__/.test(src)) {
        full = src;
      } else {
        full = wrapTailExpression(src);
      }
    }
  } else {
    full = `__RESULT__ = (${src});`;
  }
  const scope = buildScope(ctx);
  const varNames = Object.keys(scope);
  if (process.env.JS_TRACE === '1') console.error('=== 生成代码 ===\n' + full + '\n=== END ===');
  const fn = new Function(...varNames, `"use strict";var __RESULT__;(function(){${full}\n}).call(this);return __RESULT__;`);
  const out = fn(...varNames.map((n) => scope[n]));
  return unwrap(out);
}

function splitStatements(src) {
  const stmts = [];
  let depth = 0;
  let cur = '';
  let inStr = null;
  let startPos = 0;
  const atLineStart = () => cur.trim() === '';

  const flush = (endIndex) => {
    const raw = cur;
    const text = raw.trim();
    if (!text) { cur = ''; return; }
    const offset = raw.indexOf(text);
    stmts.push({ text, start: startPos + offset, end: startPos + offset + text.length });
    cur = '';
  };

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const prev = src[i - 1];
    if (inStr) {
      cur += c;
      if (c === inStr && prev !== '\\') inStr = null;
      continue;
    }
    if (cur === '' && /\s/.test(c)) { startPos = i + 1; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; cur += c; continue; }
    if (c === '{' || c === '(' || c === '[') depth++;
    if (c === '}' || c === ')' || c === ']') depth--;
    if (c === ';' && depth === 0) { flush(i); startPos = i + 1; continue; }
    // 没有分号的换行也算一条语句的结束（书源里很常见）
    if (c === '\n' && depth === 0 && cur.trim()) {
      const nextChars = src.slice(i + 1).replace(/^\s+/, '');
      const nextChar = nextChars[0] || '';
      const startsDeclaration = /^(?:var|let|const|function|if|for|while|switch|try|return|break|continue)\b/.test(nextChars);
      const continues = /^[.+\-*/%?):,}\]]/.test(nextChar)
        || /(?:&&|\|\||[+\-*/%=(,:])\s*$/.test(cur.trim());
      if (startsDeclaration || !continues) { flush(i); startPos = i + 1; continue; }
    }
    cur += c;
  }
  flush(src.length);
  return stmts;
}

/** 判断一段代码自身是否是完整语句（块结构必须成对闭合） */
function isCompleteStatement(code) {
  const s = String(code || '').trim();
  if (!s) return false;
  const opens = (s.match(/\{/g) || []).length;
  const closes = (s.match(/\}/g) || []).length;
  return opens === closes;
}

/**
 * 把块结构（try{...}catch{...} 之类）里最后一个块的最后一条语句变成返回值。
 * 书源里常见的写法是块里最后放一个表达式，靠它当结果。
 */
function wrapTailExpression(src) {
  const code = String(src || '');
  const edits = [];
  collectTailEdits(code, edits, 0);
  if (!edits.length) {
    const lastExpr = lastExpressionStatement(code);
    return lastExpr ? `${code}\n;__RESULT__ = (${lastExpr});` : code + '\n;__RESULT__ = undefined;';
  }
  edits.sort((a, b) => b.start - a.start);
  let out = code;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  if (!/__RESULT__/.test(out)) out += '\n;__RESULT__ = undefined;';
  return out;
}

/**
 * 递归找出所有“会产出值”的块，并记录需要插入 __RESULT__ 赋值的位置。
 * 覆盖：普通块、try 的 try/catch 两分支、if/else 两分支。
 */
function collectTailEdits(code, edits, base) {
  for (const b of topLevelBlocks(code)) {
    if (b.close === undefined) continue;
    const body = code.slice(b.open + 1, b.close);
    // 先递归处理内部块（相对位置要加上偏移）
    const nested = [];
    collectTailEdits(body, nested, base + b.open + 1);
    for (const e of nested) edits.push({ start: e.start, end: e.end, text: e.text });
    if (b.isCatch) {
      // catch 块里的表达式也是结果（书源常写成 catch(e){href} 作为兜底）
      const body2 = code.slice(b.open + 1, b.close);
      const stmts2 = splitStatements(body2);
      const lastStmt2 = stmts2[stmts2.length - 1];
      if (lastStmt2 && !/\b(var|let|const|function|return)\b/.test(lastStmt2.text)
        && !/^(?:try|if|for|while|switch|do|else|\{)/.test(lastStmt2.text)) {
        edits.push({
          start: base + b.open + 1 + lastStmt2.start,
          end: base + b.open + 1 + lastStmt2.end,
          text: `__RESULT__ = (${lastStmt2.text});`,
        });
      }
      continue;
    }
    // if/else：两个分支都要赋值
    if (b.isFlow && /^\s*if\b/.test(code.slice(Math.max(0, b.open - 20), b.open).trim())) {
      const decl = declarationsIn(body);
      const stmts = splitStatements(body);
      const lastStmt = stmts[stmts.length - 1];
      if (lastStmt) {
        const declM = lastStmt.text.match(/^(?:var|let|const)\s+([\w$]+)\s*=/);
        const expr = declM && decl.has(declM[1]) ? declM[1] : lastStmt.text;
        if (!/\b(var|let|const)\b/.test(expr) || declM) {
          edits.push({ start: base + b.open + 1 + lastStmt.start, end: base + b.open + 1 + lastStmt.end, text: `__RESULT__ = (${expr});` });
        }
      }
      continue;
    }
    // 普通块 / try 块：末尾表达式作为结果
    const decl = declarationsIn(body);
    const stmts = splitStatements(body);
    const lastStmt = stmts[stmts.length - 1];
    if (!lastStmt) continue;
    const declM = lastStmt.text.match(/^(?:var|let|const)\s+([\w$]+)\s*=/);
    const isExpr = !/\b(var|let|const|function|return)\b/.test(lastStmt.text)
      && !/^(?:try|if|for|while|switch|do|else|\{)/.test(lastStmt.text);
    if (isExpr) {
      edits.push({ start: base + b.open + 1 + lastStmt.start, end: base + b.open + 1 + lastStmt.end, text: `__RESULT__ = (${lastStmt.text});` });
    } else if (declM && decl.has(declM[1])) {
      edits.push({ start: base + b.open + 1 + lastStmt.end, end: base + b.open + 1 + lastStmt.end, text: `\n__RESULT__ = (${declM[1]});` });
    }
  }
}

function declarationsIn(code) {
  const set = new Set();
  const re = /\b(?:var|let|const)\s+([\w$]+)/g;
  let m;
  while ((m = re.exec(code)) !== null) set.add(m[1]);
  return set;
}

/** 找出一段代码里所有顶层块的位置与类型 */
function topLevelBlocks(code) {
  const blocks = [];
  let depth = 0;
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === '{') {
      if (depth === 0) {
        const before = code.slice(Math.max(0, i - 40), i);
        blocks.push({
          open: i,
          isCatch: /\b(catch|finally)\s*\(?[^)]*\)?\s*$/.test(before.trim()),
          isFlow: /\b(if|else|for|while|switch|do|try)\s*[({]?\s*$/.test(before.trim()),
        });
      }
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0 && blocks.length) blocks[blocks.length - 1].close = i;
    }
  }
  return blocks;
}

/** 取整段代码的最后一条表达式语句 */
function lastExpressionStatement(code) {
  const stmts = splitStatements(code).filter((s) => !/\b(var|let|const|function|return)\b/.test(s.text));
  return stmts.length ? stmts[stmts.length - 1].text : null;
}

function unwrap(v) {
  if (v === undefined || v === null) return undefined;
  if (v instanceof JsoupElement || v instanceof JsoupElements) {
    if (v instanceof JsoupElements) return v.list.map((n) => n.text || n.data || '').join('\n');
    return v.text();
  }
  if (v && typeof v === 'object' && v.type === 'element') return v.text;
  if (typeof v === 'object') return v;
  return v;
}

module.exports = { runJsRule, JsoupElement, JsoupElements, JsoupParse, wrap, wrapNodeValue, JsoupUnsupported: JsUnsupported, htmlFormat, timeFormat, splitStatements, wrapTailExpression };
