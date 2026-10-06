'use strict';
/**
 * 极简 HTML 解析器（零依赖），生成与 jsoup 类似的节点树。
 * 支持：标签、属性、注释、<script>/<style> 原文、自闭合标签、隐式闭合(p/li)、
 *      void 元素、大小写不敏感标签名、HTML 实体解码。
 * 说明：这是为 Legado 书源规则校验而写的“够用”实现，不追求完整 HTML5 规范。
 */

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr',
]);

// 这些标签在遇到同类开始标签时自动闭合（简化处理）
const AUTO_CLOSE = {
  li: new Set(['li']),
  p: new Set(['p']),
  td: new Set(['td', 'th']),
  th: new Set(['td', 'th']),
  tr: new Set(['tr']),
  option: new Set(['option']),
  dt: new Set(['dt', 'dd']),
  dd: new Set(['dt', 'dd']),
};

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  copy: '\u00a9', reg: '\u00ae', hellip: '\u2026', mdash: '\u2014',
  ndash: '\u2013', ldquo: '\u201c', rdquo: '\u201d', lsquo: '\u2018',
  rsquo: '\u2019', times: '\u00d7', middot: '\u00b7', bull: '\u2022',
  yen: '\u00a5', deg: '\u00b0', laquo: '\u00ab', raquo: '\u00bb',
  ensp: '\u2002', emsp: '\u2003', thinsp: '\u2009', zwnj: '\u200c', zwj: '\u200d',
};

function decodeEntities(str) {
  if (!str || str.indexOf('&') === -1) return str;
  return str.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isFinite(code)) return m;
      try { return String.fromCodePoint(code); } catch (e) { return m; }
    }
    const v = ENTITIES[body.toLowerCase()];
    return v === undefined ? m : v;
  });
}

class TextNode {
  constructor(text, parent) {
    this.type = 'text';
    this.data = text;
    this.parent = parent;
  }
  get text() { return decodeEntities(this.data); }
  get ownText() { return this.text; }
  get textNodes() { return this.text; }
  get raw() { return this.data; }
  get children() { return []; }
  get childNodes() { return []; }
  get tagName() { return '#text'; }
  attr() { return ''; }
  hasAttr() { return false; }
  toString() { return this.text; }
}

class Element {
  constructor(tagName, parent) {
    this.type = 'element';
    this.tagName = tagName;
    this.attrs = Object.create(null);
    this.childNodes = [];
    this.parent = parent;
    // 原始 innerHTML 片段，用于 html()/all 输出（尽量保留原貌）
    this.rawInner = null;
  }
  get children() { return this.childNodes.filter((n) => n.type === 'element'); }
  get elements() { return this.children; }
  get nodeName() { return this.tagName; }
  get id() { return this.attrs.id || ''; }
  get className() { return this.attrs.class || ''; }
  get classes() {
    return String(this.attrs.class || '').split(/\s+/).filter(Boolean);
  }
  hasAttr(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name); }
  attr(name) {
    if (name === undefined) return '';
    const v = this.attrs[String(name).toLowerCase()];
    return v === undefined ? '' : decodeEntities(v);
  }
  setAttr(name, value) { this.attrs[String(name).toLowerCase()] = String(value); }
  get text() {
    let out = '';
    for (const n of this.childNodes) {
      if (n.type === 'text') out += n.text;
      else if (n.tagName !== 'script' && n.tagName !== 'style') out += n.text;
    }
    return out;
  }
  // jsoup: textNodes 为各直接文本子节点（以空格连接更接近 jsoup 行为）
  get textNodes() {
    const parts = [];
    for (const n of this.childNodes) {
      if (n.type === 'text') {
        const t = n.text;
        if (t.trim()) parts.push(t.trim());
      }
    }
    return parts.join(' ');
  }
  get ownText() { return this.textNodes; }
  get allText() {
    let out = '';
    const walk = (node) => {
      for (const n of node.childNodes) {
        if (n.type === 'text') out += n.text;
        else if (n.tagName !== 'script' && n.tagName !== 'style') walk(n);
      }
    };
    walk(this);
    return out;
  }
  get html() { return this.innerHTML(); }
  get outerHtml() { return this.toString(); }
  innerHTML() {
    // 直接返回原始文本，避免实体二次转义（&nbsp; 不再变成 &amp;nbsp;）
    return this.childNodes.map((n) => (n.type === 'text' ? (n.raw !== undefined ? n.raw : n.data) : n.toString())).join('');
  }
  toString() {
    const attrs = Object.keys(this.attrs)
      .map((k) => ` ${k}="${escapeAttr(this.attrs[k])}"`).join('');
    if (VOID_TAGS.has(this.tagName)) return `<${this.tagName}${attrs}>`;
    return `<${this.tagName}${attrs}>${this.innerHTML()}</${this.tagName}>`;
  }
  get nextElementSibling() {
    if (!this.parent) return null;
    const sibs = this.parent.children;
    const i = sibs.indexOf(this);
    return i >= 0 && i + 1 < sibs.length ? sibs[i + 1] : null;
  }
  get previousElementSibling() {
    if (!this.parent) return null;
    const sibs = this.parent.children;
    const i = sibs.indexOf(this);
    return i > 0 ? sibs[i - 1] : null;
  }
  get parentElement() { return this.parent instanceof Element ? this.parent : null; }
}

function escapeText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

class Document {
  constructor(root) {
    this.type = 'document';
    this.childNodes = [root];
    this.root = root;
    this.parent = null;
    this.tagName = '#document';
    this.attrs = Object.create(null);
  }
  get children() { return this.childNodes.filter((n) => n.type === 'element'); }
  get text() { return this.root.text; }
  get html() { return this.root.html; }
  outerHtml() { return this.root.toString(); }
  attr() { return ''; }
  hasAttr() { return false; }
  toString() { return this.root.toString(); }
}

class Parser {
  constructor(html) {
    this.html = String(html == null ? '' : html);
    this.pos = 0;
    this.len = this.html.length;
  }

  parse() {
    const root = new Element('#root', null);
    this.build(root);
    return new Document(root);
  }

  build(root) {
    const stack = [root];
    const html = this.html;
    while (this.pos < this.len) {
      const lt = html.indexOf('<', this.pos);
      if (lt === -1) {
        this.addText(stack[stack.length - 1], html.slice(this.pos));
        this.pos = this.len;
        break;
      }
      if (lt > this.pos) this.addText(stack[stack.length - 1], html.slice(this.pos, lt));
      this.pos = lt;

      if (html.startsWith('<!--', this.pos)) {
        const end = html.indexOf('-->', this.pos + 4);
        this.pos = end === -1 ? this.len : end + 3;
        continue;
      }
      if (html.startsWith('<!', this.pos) || html.startsWith('<?', this.pos)) {
        const end = html.indexOf('>', this.pos);
        this.pos = end === -1 ? this.len : end + 1;
        continue;
      }
      if (html.startsWith('</', this.pos)) {
        const end = html.indexOf('>', this.pos);
        if (end === -1) { this.pos = this.len; break; }
        const name = html.slice(this.pos + 2, end).trim().toLowerCase().split(/\s/)[0];
        this.closeTag(stack, name);
        this.pos = end + 1;
        continue;
      }
      const tag = this.readOpenTag();
      if (!tag) {
        // 不是合法标签，按文本处理
        this.addText(stack[stack.length - 1], '<');
        this.pos += 1;
        continue;
      }
      const { name, attrs, selfClosing } = tag;
      this.pos = tag.end;
      // 自动闭合
      const autoSet = AUTO_CLOSE[name];
      if (autoSet) {
        for (let i = stack.length - 1; i > 0; i--) {
          if (autoSet.has(stack[i].tagName)) {
            stack.length = i;
            break;
          }
          if (stack[i].tagName === '#root') break;
        }
      }
      const el = new Element(name, stack[stack.length - 1]);
      for (const [k, v] of attrs) el.attrs[k] = v;
      stack[stack.length - 1].childNodes.push(el);
      if (!selfClosing && !VOID_TAGS.has(name)) stack.push(el);
      if (name === 'script' || name === 'style') {
        const close = html.toLowerCase().indexOf('</' + name, this.pos);
        const raw = close === -1 ? html.slice(this.pos) : html.slice(this.pos, close);
        if (raw) el.childNodes.push(new TextNode(raw, el));
        this.pos = close === -1 ? this.len : close;
      }
    }
  }

  addText(parent, text) {
    if (!text) return;
    parent.childNodes.push(new TextNode(text, parent));
  }

  closeTag(stack, name) {
    for (let i = stack.length - 1; i > 0; i--) {
      if (stack[i].tagName === name) {
        stack.length = i;
        return;
      }
    }
  }

  readOpenTag() {
    const html = this.html;
    let p = this.pos + 1;
    if (!/[a-zA-Z]/.test(html[p] || '')) return null;
    let i = p;
    while (i < this.len && /[^\s/>]/.test(html[i])) i++;
    const rawName = html.slice(p, i);
    const name = rawName.toLowerCase();
    const attrs = [];
    while (i < this.len) {
      while (i < this.len && /\s/.test(html[i])) i++;
      if (html[i] === '>') { i++; break; }
      if (html[i] === '/' && html[i + 1] === '>') { i += 2; return { name, attrs, selfClosing: true, end: i }; }
      if (i >= this.len) break;
      let j = i;
      while (j < this.len && /[^\s=/>]/.test(html[j])) j++;
      const aname = html.slice(i, j).toLowerCase();
      let aval = '';
      let k = j;
      while (k < this.len && /\s/.test(html[k])) k++;
      if (html[k] === '=') {
        k++;
        while (k < this.len && /\s/.test(html[k])) k++;
        const q = html[k];
        if (q === '"' || q === "'") {
          const end = html.indexOf(q, k + 1);
          aval = end === -1 ? html.slice(k + 1) : html.slice(k + 1, end);
          k = end === -1 ? this.len : end + 1;
        } else {
          let e = k;
          while (e < this.len && !/[\s>]/.test(html[e])) e++;
          aval = html.slice(k, e);
          k = e;
        }
      }
      if (aname) attrs.push([aname, aval]);
      i = k <= i ? i + 1 : k;
    }
    return { name, attrs, selfClosing: false, end: i };
  }
}

function parseHtml(html) {
  return new Parser(html).parse();
}

function parseFragment(html) {
  return new Parser(html).parse();
}

module.exports = { parseHtml, parseFragment, Element, TextNode, Document, decodeEntities, VOID_TAGS };
