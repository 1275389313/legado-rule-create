'use strict';
/**
 * Legado 书源规则解析引擎。
 * 统一入口：AnalyzeRule
 *   - getElements(ruleStr)  取节点列表（书籍列表 / 目录列表）
 *   - getString(ruleStr)    取字符串
 *   - getStringList(ruleStr)
 * 支持语法：Default(jsoup 风格) / @css: / @XPath: 或 // / @json: 或 $. / 正则净化 ##a##b
 *          连接符 && || %% / 负号倒置 / reverse / @put @get / {{}} 模板 / @js:
 */

const { parseHtml, Element, TextNode } = require('./dom');
const { selectAll } = require('./selector');
const { xpathQuery, allDescendants } = require('./xpath');
const { jsonPathQuery } = require('./jsonpath');
const { runJsRule, wrapNodeValue } = require('./jsexec');

const DEFAULT_UA = 'Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

function isUrlLike(s) {
  return typeof s === 'string' && /^(https?:)?\/\//i.test(s.trim());
}

function absUrl(base, url) {
  if (!url) return '';
  const u = String(url).trim();
  if (/^(https?:)?\/\//i.test(u) || u.startsWith('data:') || u.startsWith('mailto:')) return u;
  if (u.startsWith('javascript:')) return '';
  try {
    return new URL(u, base).href;
  } catch (e) {
    return u;
  }
}

/** 拆连接符（只在顶层） */
function splitConnect(rule) {
  const parts = [];
  let cur = '';
  let depth = 0;
  let i = 0;
  while (i < rule.length) {
    const c = rule[i];
    if (c === '(' || c === '[') depth++;
    if (c === ')' || c === ']') depth--;
    if (depth <= 0) {
      if (rule.startsWith('&&', i) || rule.startsWith('||', i) || rule.startsWith('%%', i)) {
        parts.push({ op: rule.slice(i, i + 2), text: cur });
        cur = '';
        i += 2;
        continue;
      }
    }
    cur += c;
    i++;
  }
  parts.push({ op: null, text: cur });
  return parts.filter((p, idx) => p.text !== '' || idx === parts.length - 1);
}

class AnalyzeRule {
  /**
   * @param {object} opts
   *   opts.content  当前内容：Document | Element | string(html/json) | object(json)
   *   opts.baseUrl  当前 url
   *   opts.source   书源对象（用于 header 等）
   *   opts.vars     变量池（@put/@get、{{}} 中使用）
   *   opts.json     true 表示内容是 json
   */
  constructor(opts = {}) {
    this.baseUrl = opts.baseUrl || '';
    this.vars = opts.vars || Object.create(null);
    this.source = opts.source || {};
    this.ctx = opts.ctx || Object.create(null);
    this.forcedJson = !!opts.json;
    this.setContent(opts.content, opts.baseUrl);
  }

  setContent(content, baseUrl) {
    if (baseUrl !== undefined) this.baseUrl = baseUrl || this.baseUrl;
    if (content === undefined) return this;
    if (typeof content === 'string') {
      const t = content.trim();
      if (this.forcedJson || (t.startsWith('{') || t.startsWith('['))) {
        try {
          this.json = JSON.parse(content);
          this.doc = null;
          this.contentType = 'json';
          return this;
        } catch (e) { /* 落到 html */ }
      }
      this.doc = parseHtml(content);
      this.json = null;
      this.contentType = 'html';
      return this;
    }
    if (content && typeof content === 'object' && content.type === 'document') {
      this.doc = content;
      this.json = null;
      this.contentType = 'html';
      return this;
    }
    if (content && typeof content === 'object' && content.type === 'element') {
      this.node = content;
      this.doc = null;
      this.json = null;
      this.contentType = 'node';
      return this;
    }
    this.json = content;
    this.doc = null;
    this.contentType = 'json';
    return this;
  }

  /** 根上下文节点列表 */
  rootNodes() {
    if (this.node) return [this.node];
    if (this.doc) return [this.doc];
    return [];
  }

  // ---------------- 内容获取 ----------------

  /** 取节点列表 */
  getElements(ruleStr) {
    if (ruleStr === undefined || ruleStr === null || ruleStr === '') {
      if (this.json !== null && this.json !== undefined) return this.jsonAsList();
      return this.rootNodes();
    }
    let rule = String(ruleStr).trim();
    if (rule === '-') {
      const list = this.getElements('');
      return list.slice().reverse();
    }
    let negate = false;
    if (rule.startsWith('-') && !rule.startsWith('-@')) { negate = true; rule = rule.slice(1).trim(); }

    const parts = splitConnect(rule);
    let combined = null;
    for (const part of parts) {
      const value = this.evalElementsOnce(part.text.trim());
      if (combined === null) combined = value;
      else if (part.op === '%%') combined = interleave(combined, value);
      else combined = combined.concat(value);
      // 计算并集：全部拼接（legado 的 &&/无连接符都会合并）
    }    let out = combined || [];
    if (negate) out = out.slice().reverse();
    return out;
  }

  jsonAsList() {
    if (Array.isArray(this.json)) return this.json.slice();
    return [this.json];
  }

  evalElementsOnce(rule) {
    if (!rule) return [];
    // 模板
    if (rule.includes('{{')) rule = this.template(rule, true);

    if (rule.startsWith('@css:')) {
      const sel = rule.slice(5).trim();
      const { sel: clean, tails } = splitRuleTails(sel);
      let nodes = [];
      for (const root of this.rootNodes()) nodes = nodes.concat(selectAll(root, clean));
      return applyTails(nodes, tails, this);
    }
    if (rule.startsWith('@XPath:') || rule.startsWith('//') || rule.startsWith('/html')) {
      const { sel: clean, tails } = splitRuleTails(rule);
      let nodes = [];
      for (const root of this.rootNodes()) nodes = nodes.concat(xpathQuery(root, clean));
      return applyTails(nodes.map(normalizeXPathNode), tails, this);
    }
    if (rule.startsWith('@json:') || rule.startsWith('$.')) {
      const { sel: clean, tails } = splitRuleTails(rule);
      const values = jsonPathQuery(this.json !== null && this.json !== undefined ? this.json : this.doc, clean);
      return applyTails(values, tails, this);
    }
    if (rule.startsWith(':') && !rule.startsWith('::')) {
      // AllInOne 正则（仅列表场景支持）
      return this.regexSplit(rule);
    }
    if (rule.startsWith('@js:')) {
      const vals = this.runJs(rule.slice(4), []);
      return vals;
    }
    // Default
    const { sel: clean, tails } = splitRuleTails(rule);
    let nodes = [];
    for (const root of this.rootNodes()) nodes = nodes.concat(defaultSelect(root, clean, this));
    if (!nodes.length && this.json !== null && this.json !== undefined) {
      nodes = defaultSelectJson(this.json, clean);
    }
    return applyTails(nodes, tails, this);
  }

  /** AllInOne：:regex##replacement... 用于列表 */
  regexSplit(rule) {
    const text = this.rawText();
    const [patternPart, ...rest] = rule.slice(1).split('##');
    let pattern = patternPart;
    if (pattern.includes('##')) pattern = pattern.split('##')[0];
    let re;
    try { re = new RegExp(pattern, 'gi'); } catch (e) { return []; }
    const groups = [];
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m[0] === '') { re.lastIndex++; continue; }
      groups.push(new RawValue(m[1] !== undefined && rest.length ? m[1] : m[0], m));
      if (groups.length > 5000) break;
    }
    return groups;
  }

  rawText() {
    if (this.node) {
      // Element.outerHtml 是 getter；TextNode 上没有，退化为 data
      if (typeof this.node.outerHtml === 'string') return this.node.outerHtml;
      if (typeof this.node.toString === 'function') return this.node.toString();
      return String(this.node.data || '');
    }
    if (this.doc) return this.doc.toString();
    if (typeof this.json === 'object' && this.json !== null) return JSON.stringify(this.json);
    return '';
  }

  /** 取单个字符串 */
  getString(ruleStr) {
    const list = this.getStringList(ruleStr);
    return list.length ? list[0] : '';
  }

  /** 取字符串列表 */
  getStringList(ruleStr) {
    if (ruleStr === undefined || ruleStr === null || ruleStr === '') return [];
    let rule = String(ruleStr).trim();
    if (!rule) return [];
    if (rule === '') return [];
    return this.evalStringOnce(rule);
  }

  evalStringOnce(rule) {
    if (rule === '') return [];
    if (rule.includes('{{') && !rule.startsWith('@js:')) rule = this.template(rule, false);
    const parts = splitConnect(rule);
    if (parts.length > 1) {
      if (process.env.RULE_TRACE === '1') console.error('  [conn] ' + JSON.stringify(parts.map((p) => p.op + ':' + p.text)));
      // splitConnect 的 op 属于“前一段之后”的连接符
      let result = this.evalStringOnce(parts[0].text.trim());
      for (let i = 1; i < parts.length; i++) {
        const op = parts[i - 1].op || '&&';
        if (op === '||') {
          if (result.length) continue;
          result = this.evalStringOnce(parts[i].text.trim());
        } else if (op === '%%') {
          const value = this.evalStringOnce(parts[i].text.trim());
          result = result.length ? interleave(result, value) : value;
        } else {
          result = result.concat(this.evalStringOnce(parts[i].text.trim()));
        }
      }
      return result;
    }
    const { sel, tails, js } = splitRuleTails(rule);
    let values = [];
    if (!tails.length && !js && isPlainLiteral(sel)) return [sel];
    // 纯 js 规则（如整个字段就是 @js:...）：直接把源码交给 js，result 为上下文文本
    if (!sel && js) {
      const roots = this.rootNodes();
      const seed = roots.length ? [nodeToString(roots[0], this)] : [];
      values = this.runJs(js, seed);
      values = applyTails(values, tails, this);
      return values.map((v) => nodeToString(v, this)).filter((v) => v !== undefined && v !== null);
    }
    // 形如 href@js:...、h3@text@js:...：result 为选择器取到的值
    if (js && sel) {
      try {
        let strings = this.getStringList(sel);
        // href@js:... / src@js:... 这类写法里，前面其实是取该属性的标签（a / img），
        // 且 result 应该是属性值本身（书源里常写 String(result) 后直接处理 url）
        if (!strings.length && /^(href|src)$/i.test(sel)) {
          const attr = sel.toLowerCase();
          const tag = attr === 'href' ? 'a' : 'img';
          const els = this.getElements(tag);
          strings = [];
          for (const e of els) {
            const v = extractFrom(e, attr, this);
            if (v) strings.push(String(v));
          }
        } else if (!strings.length) {
          const els = this.getElements(sel);
          if (els.length) strings = els.map((e) => nodeToString(e, this)).filter(Boolean);
        }
        if (this.ctx) delete this.ctx.jsError;
        const resultVal = strings.length <= 1 ? (strings[0] || '') : strings.slice();
        if (process.env.RULE_TRACE === '1') console.error('  [js] sel=' + sel + ' strings=' + JSON.stringify(strings).slice(0, 120) + ' result=' + JSON.stringify(resultVal).slice(0, 120));
        const out = runJsRule(prepareJsCode(js), {
          result: resultVal,
          baseUrl: this.baseUrl,
          src: this.rawText(),
          vars: this.vars,
          ctx: this.ctx,
        });
        if (out === undefined || out === null) return [];
        values = Array.isArray(out) ? out : [out];
        values = applyTails(values, tails, this);
        return values.map((v) => nodeToString(v, this)).filter((v) => v !== undefined && v !== null);
      } catch (e) {
        this.ctx.jsError = String(e && e.message || e);
        return [];
      }
    }

    if (sel.startsWith('@css:') || sel.startsWith('@XPath:') || sel.startsWith('//') || sel.startsWith('@json:')
      || sel.startsWith('$.') || sel.startsWith('@js:')) {
      if (sel.startsWith('@js:')) {
        values = this.runJs(sel.slice(4), []);
      } else if (sel.startsWith('@json:')) {
        values = jsonPathQuery(this.json !== null && this.json !== undefined ? this.json : this.doc, sel);
      } else if (sel.startsWith('@css:')) {
        values = [];
        for (const root of this.rootNodes()) values = values.concat(selectAll(root, sel.slice(5).trim()));
      } else if (sel.startsWith('@XPath:') || sel.startsWith('//')) {
        values = [];
        for (const root of this.rootNodes()) values = values.concat(xpathQuery(root, sel));
      }
    } else {
      for (const root of this.rootNodes()) values = values.concat(defaultSelect(root, sel, this));
      if (!values.length && this.json !== null && this.json !== undefined) values = defaultSelectJson(this.json, sel);
    }
    values = applyTails(values, tails, this);
    if (js) values = this.runJs(js, values);
    return values.map((v) => nodeToString(v, this)).filter((v) => v !== undefined && v !== null);
  }

  runJs(code, values) {
    try {
      const out = runJsRule(code, {
        result: values.length === 1 ? values[0] : values,
        baseUrl: this.baseUrl,
        src: this.rawText(),
        vars: this.vars,
        ctx: this.ctx,
      });
      if (out === undefined || out === null || out === '') return values;
      if (Array.isArray(out)) return out;
      return [out];
    } catch (e) {
      this.ctx.jsError = String(e && e.message || e);
      return values;
    }
  }

  /** {{ }} 模板：默认 js，可带 @css:/@XPath:/@json:/@@ 前缀 */
  template(str, returnNodes) {
    return String(str).replace(/\{\{([\s\S]*?)\}\}/g, (m, inner) => {
      const expr = inner.trim();
      if (expr.startsWith('@@')) {
        const r = new AnalyzeRule({ content: this.doc || this.node, baseUrl: this.baseUrl, vars: this.vars, ctx: this.ctx });
        const v = r.getElements(expr.slice(2));
        return joinValues(v, this);
      }
      if (expr.startsWith('@css:') || expr.startsWith('@XPath:') || expr.startsWith('@json:') || expr.startsWith('//') || expr.startsWith('$.')) {
        const r = new AnalyzeRule({ content: this.doc || this.node, baseUrl: this.baseUrl, vars: this.vars, ctx: this.ctx });
        return r.getString(expr);
      }
      try {
        const out = runJsRule(expr, {
          result: this.ctx.key !== undefined ? this.ctx.key : '',
          baseUrl: this.baseUrl,
          src: this.rawText(),
          vars: this.vars,
          ctx: this.ctx,
          key: this.ctx.key,
          page: this.ctx.page,
        });
        return out === undefined || out === null ? '' : String(out);
      } catch (e) {
        return '';
      }
    });
  }
}

/** @js: 处理：把规则拆成「选择器 + 尾巴序列」，尾巴可以是 ## 净化或 @js: 代码 */
function splitRuleTails(rule) {
  const s = String(rule || '');
  // 纯 js 规则：整段就是代码（交给 runJs）
  if (s.startsWith('@js:') || /^<js>/i.test(s.trim())) {
    return { sel: '', tails: [], js: prepareJsCode(s.replace(/^@js:/, '')) };
  }
  const segs = [];
  let buf = '';
  let jsBuf = null;
  let inJs = false;
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    // 不在 js 里时，遇到 ## 就切出净化尾巴
    if (!inJs && c === '#' && s[i + 1] === '#') {
      if (buf.trim()) segs.push({ sel: buf.trim() });
      buf = '';
      // 收集到下一个 ##（或结尾）
      let j = i;
      let end = s.indexOf('##', i + 2);
      if (end === -1) {
        segs.push({ sel: s.slice(i) });
        buf = '';
        i = s.length;
        break;
      }
      segs.push({ sel: s.slice(i, end) });
      i = end - 1;
      continue;
    }
    if (inJs) {
      // 在 js 里遇到新的 ## 尾巴或规则结尾
      if (!quote && c === '#' && s[i + 1] === '#') {
        segs.push({ js: prepareJsCode(jsBuf) });
        jsBuf = null;
        inJs = false;
        buf = '##';
        i += 1;
        continue;
      }
      if (!quote && (c === '"' || c === "'" || c === '`')) quote = c;
      else if (quote && c === quote && s[i - 1] !== '\\') quote = null;
      jsBuf += c;
      continue;
    }
    if (!quote && s.startsWith('@js:', i)) {
      const selPart = buf.trim();
      if (selPart) segs.push({ sel: selPart });
      buf = '';
      jsBuf = '';
      inJs = true;
      i += 3;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      if (quote === c) quote = null;
      else if (!quote) quote = c;
    }
    buf += c;
  }
  if (inJs) segs.push({ js: prepareJsCode(jsBuf) });
  else if (buf.trim()) segs.push({ sel: buf.trim() });

  // 合并成 { sel, tails, js }
  let sel = '';
  let js = null;
  const tails = [];
  for (const seg of segs) {
    if (seg.js !== undefined) { js = seg.js; continue; }
    if (seg.sel === undefined) continue;
    const part = seg.sel;
    if (part.startsWith('##')) {
      const parsed = parseTail(part);
      if (parsed) tails.push(parsed);
    } else if (part) {
      sel = sel ? sel + part : part;
    }
  }
  return { sel: sel.trim(), tails, js };
}

/** 解析 ##replacement 或 ##regex##replacement 或 ### */
function parseTail(tail) {
  if (!tail.startsWith('##')) return null;
  const body = tail.slice(2);
  if (body === '') return null;
  // 判断形式：###... 表示 OnlyOne？ Legado: ##正则##替换  => 循环替换；###正则##替换 => 只替换一次
  const parts = body.split('##');
  if (parts.length >= 2) {
    return { regex: parts[0], replacement: parts[1] === undefined ? '' : parts[1], all: true };
  }
  return { regex: parts[0], replacement: '', all: true };
}

function applyTails(values, tails, analyzer) {
  let out = values;
  for (const t of tails) {
    if (!t) continue;
    let re;
    try { re = new RegExp(t.regex, 'g'); } catch (e) { continue; }
    out = out.map((v) => {
      if (v === undefined || v === null) return v;
      if (v instanceof RawValue) {
        v = new RawValue(String(v.value).replace(re, t.replacement), v.match);
        return v;
      }
      if (typeof v === 'string') return v.replace(re, t.replacement);
      if (typeof v === 'number' || typeof v === 'boolean') return String(v).replace(re, t.replacement);
      if (v && v.type === 'element') return v.text.replace(re, t.replacement);
      return v;
    });
  }
  return out;
}

const JS_STRING_ESCAPES = { n: '\n', t: '\t', r: '\r', '0': '\0', b: '\b', f: '\f' };

/**
 * 把一段在书源里写成字符串的 JS 还原成可执行源码。
 * 形如 "let href = String(result)\ntry{...}" 时，双引号在 JSON 里没转义，
 * 直接当代码跑会语法错误；这里把字面量里的 \n \t \" 还原，并给裸双引号兜底。
 */
function prepareJsCode(code) {
  let s = String(code == null ? '' : code);
  s = s.replace(/^<js>/i, '').replace(/<\/js>$/i, '');
  if (!/\\[ntr"']/.test(s)) return s.trim();
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) {
      const n = s[i + 1];
      if (n === 'n') { out += '\n'; i++; continue; }
      if (n === 't') { out += '\t'; i++; continue; }
      if (n === 'r') { out += '\r'; i++; continue; }
      if (n === '"' || n === "'" || n === '\\' || n === '/') { out += n; i++; continue; }
      out += c;
      continue;
    }
    if (c === '"') {
      // 裸双引号（书源里常见）→ 单引号，避免语法错误
      out += "'";
      continue;
    }
    out += c;
  }
  return out.trim();
}

class RawValue {
  constructor(value, match) { this.value = value; this.match = match; this.__raw = true; }
  toString() { return String(this.value); }
}

function normalizeXPathNode(n) {
  if (n && n.__attr !== undefined) return new RawValue(n.__attr);
  return n;
}

function isPlainLiteral(s) {
  if (s === '') return false;
  // 若包含规则分隔符或规则关键字，则不是纯文本
  if (s.includes('@') || s.includes('##')) return false;
  if (RULE_KEYWORDS.test(s)) return false;
  // 形如 class.odd.0 / tag.a / id.wrap / text.xxx 都是规则
  if (/^(class|tag|id|text|children|style)\b/.test(s)) return false;
  if (/^-?\d+$/.test(s)) return false;
  if (/^\[.*\]$/.test(s)) return false;
  const CONTEXT = /^(object|array|string|number|boolean|url|baseUrl|bookName|title|key|page|result|src)$/i;
  if (CONTEXT.test(s)) return false;
  if (/^https?:\/\//i.test(s)) return false;
  const trimmed = s.trim();
  if (!trimmed) return false;
  if (!/[\w\u4e00-\u9fa5]/.test(trimmed)) return false;
  return true;
}

const RULE_KEYWORDS = /^(children|text|textNodes|ownText|html|all|href|src|content|class|id|tag|style|value|title|alt|data|object|absolute|url|baseUrl|textNodes)\b/;

function interleave(a, b) {
  const out = [];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (i < a.length) out.push(a[i]);
    if (i < b.length) out.push(b[i]);
  }
  return out;
}

function joinValues(list, analyzer) {
  return list.map((v) => nodeToString(v, analyzer)).join('\n');
}

// ---------------- Default 规则（jsoup 风格） ----------------

const EXTRACT_OPS = new Set(['text', 'textNodes', 'ownText', 'html', 'all', 'outerHtml', 'href', 'src',
  'content', 'value', 'title', 'alt', 'data-src', 'data-original', 'abs:href', 'abs:src']);

function parseDefaultRule(ruleStr) {
  const raw = String(ruleStr);
  const segs = raw.split('@');
  const steps = [];
  segs.forEach((seg, i) => {
    const isLast = i === segs.length - 1;
    const s = seg.trim();
    if (!s) return;
    if (/^-?[a-zA-Z][\w-]*:-?\d/.test(s) === false && /^[a-zA-Z]+:/.test(s)) {
      steps.push({ kind: 'pseudo', text: s });
      return;
    }
    if (isLast && EXTRACT_OPS.has(s.replace(/^abs:/, ''))) {
      steps.push({ kind: 'extract', text: s });
      return;
    }
    // 最后一段可能是属性名（如 @href、@title），也可能是标签名（如 class.list@a、ul@li）
    // 这里先按“末段标记”留待 defaultSelect 根据实际元素判断
    if (isLast && /^[a-zA-Z][\w:-]*$/.test(s) && !/^(class|tag|id|text|children|style)$/i.test(s)) {
      steps.push({ kind: 'last', text: s });
      return;
    }
    if (/^\[.*\]$/.test(s) && !/^\[[a-zA-Z@]/.test(s)) {
      steps.push({ kind: 'range', text: s });
      return;
    }
    if (/^-?\d+$/.test(s)) {
      steps.push({ kind: 'index', text: s });
      return;
    }
    if (/^children(\[.*\])?$/.test(s)) {
      steps.push({ kind: 'children', text: s });
      return;
    }
    if (/^text:/.test(s)) {
      steps.push({ kind: 'pseudo', text: s });
      return;
    }
    if ((s.startsWith('.') && !/^\.-?\d/.test(s)) || /^(reverse|even|odd)$/.test(s)) {
      // .-1 / .0 是位置；.author / .book-item 是 CSS 类选择器
      steps.push({ kind: 'index', text: s });
      return;
    }
    if (s.startsWith('!')) {
      steps.push({ kind: 'exclude', text: s });
      return;
    }
    const colon = s.indexOf(':');
    if (colon > 0 && !EXTRACT_OPS.has(s) && !/^\d+$/.test(s.slice(colon + 1, colon + 2))) {
      const type = s.slice(0, colon);
      const rest = s.slice(colon + 1);
      if (/(class|id|tag|text|children|style)$/.test(type) || type === 'text') {
        steps.push({ kind: 'pseudo', text: s });
        return;
      }
    }
    steps.push({ kind: 'selector', text: s });
  });
  return steps;
}

/** 从规则段尾部拆出位置/排除/区间说明
 *  支持：class.row.-1、tag.div!0、a.0、dd.book_other.1:2、tag.div[1:2]、a[!0]、a[0,2]
 */
function splitPositionSpec(s) {
  const info = { indexes: [], excludes: [], range: null, has: false };
  let str = String(s || '');
  if (!str) return { str, info };

  // 1) 尾部 [..]：纯数字 / 区间 / 逗号 / 排除
  const bm = str.match(/\[([!,\d:\s-]*)\]$/);
  if (bm) {
    const inside = bm[1].trim();
    if (inside !== '') {
      str = str.slice(0, bm.index);
      info.has = true;
      if (inside.startsWith('!')) {
        for (const one of inside.slice(1).split(',')) {
          for (const seg of one.split(':')) {
            if (seg.trim() === '') continue;
            const n = Number(seg);
            if (!Number.isNaN(n)) info.excludes.push(n);
          }
        }
      } else if (inside.includes(':')) {
        info.range = `[${inside}]`;
      } else {
        for (const one of inside.split(',')) {
          if (one.trim() === '') continue;
          const n = Number(one);
          if (!Number.isNaN(n)) info.indexes.push(n);
        }
      }
    }
  }

  // 2) 尾部位置说明：以点开头（如 .-1 / .0 / .1:2 / .!0）或紧跟在名字后的 !N / !N:M
  const dm = str.match(/\.(!?-?\d+(?::-?\d+)?)$/) || str.match(/(?<=[a-zA-Z\u4e00-\u9fa5])(!\d+(?::\d+)*)$/);
  if (dm) {
    const body = dm[1];
    str = str.slice(0, dm.index);
    info.has = true;
    if (body.startsWith('!')) {
      for (const one of body.slice(1).split(':').filter((x) => x !== '')) {
        const n = Number(one);
        if (!Number.isNaN(n)) info.excludes.push(n);
      }
    } else if (body.includes(':')) {
      info.range = `[${body}]`;
    } else {
      info.indexes.push(Number(body));
    }
  }
  // 3) .-1 这类负下标（上面正则已覆盖），再兜底处理形如 .0!1
  const dm2 = str.match(/\.(\d+)!(\d+(?::\d+)*)$/);
  if (dm2) {
    str = str.slice(0, dm2.index);
    info.has = true;
    info.indexes.push(Number(dm2[1]));
    for (const one of dm2[2].split(':').filter((x) => x !== '')) {
      const n = Number(one);
      if (!Number.isNaN(n)) info.excludes.push(n);
    }
  }
  return { str: str.trim(), info };
}

function parseSelectorSeg(s) {
  const raw = String(s || '').trim();
  if (!raw) return null;

  // 形如 [class="row"].-1 / [id=intro_pc]：Legado 里等价于 class.X / id.X，可带位置
  const attrOnly = raw.match(/^\[(class|id)\s*=\s*["']?([^"'\]]+)["']?\]/i);
  if (attrOnly && attrOnly[0].length <= raw.length) {
    const tail = raw.slice(attrOnly[0].length);
    const info = splitPositionSpec(tail).info;
    return {
      type: attrOnly[1].toLowerCase() === 'class' ? 'class' : 'id',
      name: attrOnly[2],
      indexes: info.indexes, excludes: info.excludes, range: info.range,
      inferTag: false,
    };
  }

  // 完整的 CSS 选择器（含层级/属性/伪类）：交给 CSS 引擎处理
  if (/[\[\]>#:,\s]/.test(raw) || /^[a-zA-Z][\w-]*\*/.test(raw)) {
    const { str, info } = splitPositionSpec(raw);
    const sel = str.trim();
    if (!sel) return null;
    if (!/[\[\]>#:,\s]/.test(sel)) {
      // 退化成简单段（如 a.0 被拆掉位置后剩 a）
      return buildSimpleSeg(sel, info);
    }
    return { type: 'css', name: sel, indexes: info.indexes, excludes: info.excludes, range: info.range, cssText: sel, inferTag: false };
  }
  const { str: body, info } = splitPositionSpec(raw);
  return buildSimpleSeg(body, info);
}

function buildSimpleSeg(body, info) {
  const str = String(body || '').trim();
  const out = {
    type: 'tag', values: [], name: '', inferTag: true,
    indexes: info.indexes.slice(), excludes: info.excludes.slice(), range: info.range,
  };
  if (!str) {
    if (out.indexes.length || out.excludes.length || out.range) { out.type = 'css'; out.name = '*'; out.cssText = '*'; }
    return out;
  }
  // 纯 CSS 类名：.author / .book-item
  if (/^\.[\w\u00a0-\uffff-]+$/.test(str)) {
    out.type = 'class';
    out.name = str.slice(1);
    out.inferTag = false;
    return out;
  }
  const m = str.match(/^([a-zA-Z]+)\.(.*)$/);
  if (m && /^(class|tag|id|text|children|style)$/i.test(m[1])) {
    out.type = m[1].toLowerCase();
    out.inferTag = false;
    out.name = m[2];
  } else {
    out.type = 'tag';
    out.name = str;
  }
  return out;
}

function childrenOf(node) {
  if (node.type === 'document') return node.children;
  return node.children;
}

function defaultSelect(root, ruleStr, analyzer) {
  let rule = String(ruleStr || '').trim();
  if (!rule || rule === 'children') {
    if (rule === 'children') return childrenOf(root.type === 'document' ? root.root : root);
    return root.type === 'document' || root.type === 'element' ? [root] : [];
  }
  let negate = false;
  if (rule.startsWith('-')) { negate = true; rule = rule.slice(1); }
  const steps = parseDefaultRule(rule);
  let current = [root];
  let finalExtract = null;

  for (let si = 0; si < steps.length; si++) {
    const step = steps[si];
    const next = [];
    if (step.kind === 'last') {
      // 末段：如果当前元素确实带这个属性，就是取值；否则当作标签选择器继续往下选
      const list = flatList(current);
      const attrHit = list.some((n) => n && n.type === 'element' && n.hasAttr && n.hasAttr(step.text));
      if (attrHit) {
        finalExtract = step.text;
        continue;
      }
      let matched = [];
      for (const node of list) matched = matched.concat(matchBySeg(node, {
        type: 'tag', name: step.text, inferTag: true, indexes: [], excludes: [], range: null,
      }));
      current = matched;
      continue;
    }
    if (step.kind === 'extract') { finalExtract = step.text; continue; }
    if (step.kind === 'index') {
      const t = String(step.text);
      if (/^-?\d+$/.test(t) || t === 'reverse' || t === 'even' || t === 'odd' || /^\.-?\d+(:.*)?$/.test(t)) {
        current = applyIndexOp(current, t);
        continue;
      }
      // 形如 .author / .book-item 的 CSS 类选择器，按选择器处理
      const seg = parseSelectorSeg(t);
      let list = [];
      for (const node of flatList(current)) list = list.concat(matchBySeg(node, seg));
      current = list;
      continue;
    }
    if (step.kind === 'range') {
      current = applyRange(current, step.text);
      continue;
    }
    if (step.kind === 'exclude') {
      const idx = Number(step.text.slice(1));
      const flat = flatList(current);
      current = flat.filter((_, i) => (idx < 0 ? i !== flat.length + idx : i !== idx));
      continue;
    }
    if (step.kind === 'children') {
      const m = step.text.match(/^children(\[(.*)\])?$/);
      let list = [];
      for (const node of flatList(current)) list = list.concat(childrenOf(node.type === 'document' ? node.root : node));
      if (m && m[2] !== undefined) list = applyRange(list, '[' + m[2] + ']');
      current = list;
      continue;
    }
    if (step.kind === 'pseudo') {
      current = applyPseudoStep(flatList(current), step.text);
      continue;
    }
    // selector（位置与排除都相对于“每个上下文节点”的匹配结果）
    const seg = parseSelectorSeg(step.text);
    let list = [];
    for (const node of flatList(current)) {
      let matched = matchBySeg(node, seg);
      if (seg && seg.indexes && seg.indexes.length) {
        const picked = [];
        for (const i of seg.indexes) {
          const real = i < 0 ? matched.length + i : i;
          if (matched[real] !== undefined) picked.push(matched[real]);
        }
        matched = picked;
      }
      if (seg && seg.range) {
        matched = applyRange(matched, seg.range);
      }
      if (seg && seg.excludes && seg.excludes.length) {
        matched = applyExcludeSpec(matched, seg.excludes);
      }
      if (process.env.RULE_TRACE === '1') console.error(`  [step] ${step.kind} ${step.text} seg=${JSON.stringify(seg)} -> ${matched.length}`);
      list = list.concat(matched);    }
    current = list;
  }

  let out = flatList(current);
  if (finalExtract && out.length) {
    out = out.map((n) => extractFrom(n, finalExtract, analyzer)).filter((v) => v !== undefined && v !== null && v !== '');
  } else if (out.length && steps.length) {
    // 最后一段若是普通属性名（如 @title、@data-id），则按属性取值；
    // 若是标准取值操作则由 EXTRACT_OPS 分支处理。
    const lastStep = steps[steps.length - 1];
    const guess = lastStep && lastStep.kind === 'selector' ? lastStep.text : '';
    if (guess && /^[a-zA-Z][\w:-]*$/.test(guess) && !/^(class|tag|id|text|children|style)$/i.test(guess)) {
      const attrHit = out.some((n) => n && n.type === 'element' && n.hasAttr && n.hasAttr(guess));
      if (attrHit) {
        out = out.map((n) => extractFrom(n, guess, analyzer)).filter((v) => v !== undefined && v !== null && v !== '');
      }
    }
  }
  // 兜底：首个取值操作没取到任何东西时，把它当作标签名再试一次
  //（书源里 href@js:... 这种写法，前面的 href 其实是指 <a> 标签）
  if (!out.length && steps.length === 1 && steps[0].kind === 'extract') {
    const tag = steps[0].text.replace(/^abs:/, '');
    if (/^[a-zA-Z][\w-]*$/.test(tag)) {
      let matched = [];
      for (const node of flatList([root])) {
        matched = matched.concat(matchBySeg(node, {
          type: 'tag', name: tag, inferTag: true, indexes: [], excludes: [], range: null,
        }));
      }
      out = matched;
    }
  }
  return negate ? out.slice().reverse() : out;
}

function flatList(list) {
  const out = [];
  for (const n of list) {
    if (Array.isArray(n)) out.push(...flatList(n));
    else out.push(n);
  }
  return out;
}

function matchBySeg(node, seg) {
  if (!seg) return [];
  let list = [];
  const type = seg.inferTag ? 'tag' : seg.type;
  const root0 = node.type === 'document' ? node.root : node;
  if (type === 'css') {
    list = selectAll(root0, seg.cssText || seg.name || '*');
  } else if (type === 'children') list = childrenOf(root0);
  else if (type === 'tag') {
    list = allDescendants(root0).filter((n) => matchesName(n, seg.name));
  } else if (type === 'class') {
    list = allDescendants(root0).filter((n) => n.type === 'element' && n.classes.includes(seg.name));
  } else if (type === 'id') {
    list = allDescendants(root0).filter((n) => n.type === 'element' && n.id === seg.name);
  } else if (type === 'text') {
    list = allDescendants(root0).filter((n) => {
      if (n.type === 'text') return n.text.trim() === seg.name;
      return n.type === 'element' && n.ownText.trim() === seg.name;
    });
  } else if (type === 'style') {
    list = allDescendants(root0).filter((n) => n.type === 'element' && String(n.attr('style')).includes(seg.name));
  } else {
    return [];
  }
  return list;
}

function matchesName(n, name) {
  if (n.type !== 'element') return false;
  if (!name) return true;
  const parts = name.split('.');
  if (n.tagName !== parts[0].toLowerCase()) return false;
  for (let i = 1; i < parts.length; i++) if (!n.classes.includes(parts[i])) return false;
  return true;
}

function applyIndexOp(list, text) {
  const flat = flatList(list);
  if (text === 'reverse') return flat.slice().reverse();
  if (text === 'even') return flat.filter((_, i) => i % 2 === 0);
  if (text === 'odd') return flat.filter((_, i) => i % 2 === 1);
  const m = text.match(/^\.(-?\d+)(:(!?-?\d+)?)?$/);
  if (m) {
    const start = Number(m[1]);
    const out = [];
    const real = start < 0 ? flat.length + start : start;
    if (flat[real] !== undefined) out.push(flat[real]);
    return out;
  }
  if (/^-?\d+$/.test(text)) {
    const i = Number(text);
    const real = i < 0 ? flat.length + i : i;
    return flat[real] === undefined ? [] : [flat[real]];
  }
  return flat;
}

function applyRange(list, text) {
  const flat = flatList(list);
  const body = text.replace(/^\[|\]$/g, '').trim();
  if (!body) return flat;
  const negateFirst = body.startsWith('!');
  const b = negateFirst ? body.slice(1) : body;
  let picked;
  if (b.includes(':') && !b.includes(',')) {
    const [a, c, d] = b.split(':');
    let start = a.trim() === '' ? 0 : Number(a);
    let end = c === undefined || c.trim() === '' ? flat.length : Number(c);
    let step = d === undefined || d.trim() === '' ? 1 : Number(d);
    if (start < 0) start = flat.length + start;
    if (end < 0) end = flat.length + end;
    picked = [];
    if (step > 0) for (let i = start; i < end; i += step) if (flat[i] !== undefined) picked.push(flat[i]);
    else for (let i = start; i > end; i += step) if (flat[i] !== undefined) picked.push(flat[i]);
  } else {
    picked = [];
    for (const one of b.split(',')) {
      const t = one.trim();
      if (t === '') continue;
      if (t.includes(':')) {
        const [a, c, d] = t.split(':');
        let start = a.trim() === '' ? 0 : Number(a);
        let end = c === undefined || c.trim() === '' ? flat.length : Number(c);
        const step = d === undefined || d.trim() === '' ? 1 : Number(d);
        if (start < 0) start = flat.length + start;
        if (end < 0) end = flat.length + end;
        if (step > 0) for (let i = start; i < end; i += step) if (flat[i] !== undefined) picked.push(flat[i]);
        else for (let i = start; i > end; i += step) if (flat[i] !== undefined) picked.push(flat[i]);
        continue;
      }
      const n = Number(t);
      const real = n < 0 ? flat.length + n : n;
      if (flat[real] !== undefined) picked.push(flat[real]);
    }
  }
  if (negateFirst) {
    const set = new Set(picked);
    return flat.filter((x) => !set.has(x));
  }
  return picked;
}

function applyExcludeSpec(list, spec) {
  // spec: [0, 2] 或 [0,1,2]（排除这些位置的元素，负数从末尾计算）
  const out = list.slice();
  const parts = Array.isArray(spec) ? spec : String(spec).split(':');
  const toRemove = [];
  for (const p of parts) {
    const n = Number(p);
    if (Number.isNaN(n)) continue;
    toRemove.push(n < 0 ? out.length + n : n);
  }
  toRemove.sort((a, b) => b - a);
  for (const i of toRemove) if (i >= 0 && i < out.length) out.splice(i, 1);
  return out;
}

function applyPseudoStep(list, text) {
  const m = text.match(/^([a-zA-Z]+):(.*)$/);
  if (!m) return list;
  const type = m[1].toLowerCase();
  const rest = m[2];
  const out = [];
  for (const node of list) {
    const children = childrenOf(node.type === 'document' ? node.root : node);
    let cands = [];
    if (type === 'class') cands = allDescendants(node.type === 'document' ? node.root : node).filter((n) => n.type === 'element' && n.classes.includes(rest));
    else if (type === 'tag') cands = children.filter((n) => n.type === 'element' && n.tagName === rest.toLowerCase());
    else if (type === 'id') cands = allDescendants(node.type === 'document' ? node.root : node).filter((n) => n.type === 'element' && n.id === rest);
    else if (type === 'text') {
      cands = allDescendants(node.type === 'document' ? node.root : node).filter((n) => n.type === 'element' && n.text.includes(rest));
    } else if (type === 'children') {
      cands = children;
    }
    out.push(...cands);
  }
  return out;
}

function extractFrom(node, op, analyzer) {
  if (node === undefined || node === null) return '';
  if (node instanceof RawValue) return String(node.value);
  if (typeof node === 'string') return node;
  if (typeof node === 'number' || typeof node === 'boolean') return String(node);
  const isAbs = op.startsWith('abs:');
  const realOp = isAbs ? op.slice(4) : op;
  if (node.type === 'text') {
    return realOp === 'html' || realOp === 'all' || realOp === 'outerHtml' ? node.data : node.text;
  }
  if (node.__attr !== undefined) return String(node.__attr);
  switch (realOp) {
    case 'text': return node.text;
    case 'textNodes': return node.textNodes;
    case 'ownText': return node.ownText;
    case 'html':
    case 'all': return node.type === 'document' ? node.toString() : node.innerHTML();
    case 'outerHtml': return node.toString();
    case 'href':
    case 'abs:href': {
      const v = node.attr('href');
      return isAbs || realOp === 'abs:href' ? absUrl(analyzer.baseUrl, v) : v;
    }
    case 'src':
    case 'abs:src': {
      const v = node.attr('src') || node.attr('data-src') || node.attr('data-original');
      return isAbs || realOp === 'abs:src' ? absUrl(analyzer.baseUrl, v) : v;
    }
    case 'data-src': return node.attr('data-src');
    case 'data-original': return node.attr('data-original');
    default:
      if (node.type === 'element') {
        if (node.hasAttr(realOp)) return node.attr(realOp);
        return node.text;
      }
      return String(node);
  }
}

function nodeToString(node, analyzer) {
  if (node === undefined || node === null) return '';
  if (node instanceof RawValue) return String(node.value);
  if (typeof node === 'string') return node;
  if (typeof node === 'number' || typeof node === 'boolean') return String(node);
  if (node.type === 'text') return node.text;
  if (node.__attr !== undefined) return String(node.__attr);
  if (node.type === 'document') return node.text;
  if (node.type === 'element') return node.text;
  if (typeof node === 'object') return JSON.stringify(node);
  return String(node);
}

// ---------------- Default 规则用于 JSON 内容 ----------------

function defaultSelectJson(json, ruleStr) {
  if (ruleStr === '' || ruleStr === 'children') return Array.isArray(json) ? json.slice() : [json];
  let rule = String(ruleStr).trim();
  let negate = false;
  if (rule.startsWith('-')) { negate = true; rule = rule.slice(1); }
  const segs = rule.split('@').map((s) => s.trim()).filter(Boolean);
  let current = [json];
  for (const seg of segs) {
    const next = [];
    if (seg === 'text' || seg === 'all' || seg === 'html' || seg === 'ownText') {
      for (const n of current) next.push(typeof n === 'string' ? n : JSON.stringify(n));
      current = next;
      continue;
    }
    const child = seg.match(/^([\w$-]+)(?:\.(-?\d+))?$/);
    const idxMatch = seg.match(/^-?\d+$/);
    for (const node of flatList(current)) {
      if (idxMatch) {
        const i = Number(seg);
        if (Array.isArray(node)) {
          const real = i < 0 ? node.length + i : i;
          if (node[real] !== undefined) next.push(node[real]);
        }
        continue;
      }
      if (child) {
        const key = child[1];
        let value;
        if (Array.isArray(node)) {
          const i = child[2] !== undefined ? Number(child[2]) : 0;
          const real = i < 0 ? node.length + i : i;
          value = node[real] && node[real][key];
        } else if (node && typeof node === 'object') {
          value = node[key];
        }
        if (value !== undefined) {
          if (Array.isArray(value)) next.push(...value);
          else next.push(value);
        }
        continue;
      }
      const plain = seg;
      if (node && typeof node === 'object' && !Array.isArray(node) && node[plain] !== undefined) {
        const value = node[plain];
        if (Array.isArray(value)) next.push(...value);
        else next.push(value);
      }
    }
    current = next;
  }
  return negate ? current.slice().reverse() : current;
}

module.exports = {
  AnalyzeRule, DEFAULT_UA, absUrl, splitConnect, defaultSelect, nodeToString, parseDefaultRule, parseSelectorSeg,
  splitRuleTails, prepareJsCode,
};
