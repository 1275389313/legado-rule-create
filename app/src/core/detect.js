'use strict';
/**
 * 通用网页结构嗅探：从 HTML/JSON 中自动发现
 *   - 搜索入口（表单 / query 参数 / JSON 接口）
 *   - 书籍列表（重复结构块 + 书链接）
 *   - 详情页字段
 *   - 目录列表
 *   - 正文容器
 * 全部产出 Legado 规则字符串，并带置信度评分。
 */

const { parseHtml } = require('./dom');
const { selectAll } = require('./selector');
const { jsonPathQuery } = require('./jsonpath');
const { absUrl } = require('./urlutil');

function outerHtml(node) {
  return node && typeof node.toString === 'function' ? node.toString() : '';
}

/**
 * 评估一组候选列表项的质量：链接覆盖率、文本长度、条目数量、书链接特征。
 */
function evaluateListItems(items) {
  if (!items.length) return -1;
  let withLink = 0;
  let textOk = 0;
  let bookHref = 0;
  const hrefs = [];
  for (const it of items.slice(0, 40)) {
    const a = selectAll(it, 'a[href]')[0];
    if (a) {
      withLink++;
      const h = a.attr('href');
      hrefs.push(h);
      if (isBookLikeHref(h)) bookHref++;
    }
    const len = it.text.trim().length;
    if (len >= 4 && len <= 300) textOk++;
  }
  const n = Math.min(40, items.length);
  const linkRatio = withLink / n;
  const textRatio = textOk / n;
  const bookRatio = withLink ? bookHref / withLink : 0;
  // 所有链接指向同一个地址 → 基本是栏目/导航而不是书籍列表
  const uniqueRatio = hrefs.length ? new Set(hrefs).size / hrefs.length : 0;
  const countBonus = Math.min(items.length, 40) / 40;
  return linkRatio * 3 + textRatio * 1 + bookRatio * 3 + uniqueRatio * 2
    + countBonus - Math.max(0, items.length - 200) / 100;
}

/** 链接是否像“书籍/章节详情页” */
function isBookLikeHref(href) {
  const h = String(href || '');
  if (!h || /^javascript:/i.test(h)) return false;
  return /\/\d+\/\d+\/?$/.test(h)
    || /\/\d+\/\d+\/[^/]*\.html?$/i.test(h)
    || /\/book\/?\d*/i.test(h)
    || /\/novel\//i.test(h)
    || /\/read\//i.test(h)
    || /\/info\//i.test(h)
    || /\/\d+\.html?$/i.test(h)
    || /\/txt\/|\/xs\/|\/article\//i.test(h);
}

const LINK_TEXT_RE = /(?:第\s*[0-9一二三四五六七八九十百千零两]+\s*[章节回卷话]|正文|序章|楔子|番外|尾章|大结局|Chapter\s*\d+)/i;

/** 生成某元素的唯一稳定选择器路径（尽量短） */
function cssPathLegacy(el, root, opts = {}) {
  const maxDepth = opts.maxDepth || 4;
  const segs = [];
  let node = el;
  let depth = 0;
  while (node && node.type === 'element' && depth < maxDepth) {
    let seg = node.tagName;
    if (node.id) {
      seg = `${node.tagName}#${cssEscapeIdent(node.id)}`;
      segs.unshift(seg);
      break;
    }
    const classes = (node.classes || []).filter((c) => c && !/^\d/.test(c));
    if (classes.length) seg += '.' + classes.map(cssEscapeIdent).join('.');
    const parent = node.parent;
    if (parent && parent.children) {
      const same = parent.children.filter((c) => c.tagName === node.tagName);
      if (same.length > 1) seg += `:nth-child(${parent.children.indexOf(node) + 1})`;
    }
    segs.unshift(seg);
    node = parent;
    depth++;
  }
  const path = segs.join(' > ');
  return path || el.tagName;
}

function cssEscapeIdent(s) {
  return String(s).replace(/([^\w\u00a0-\uffff-])/g, '\\$1');
}

/**
 * 生成简单 CSS 路径：优先用 #id / .class（全页唯一时），避免 nth-child 脆弱路径。
 */
function simpleCssPath(el, root, maxDepth = 4) {
  const segs = [];
  let node = el;
  let depth = 0;
  while (node && node.type === 'element' && depth < maxDepth) {
    const classes = (node.classes || []).filter((c) => c && !/^\d/.test(c));
    if (node.id && !/^\d/.test(node.id)) {
      segs.unshift(`${node.tagName}#${cssEscapeIdent(node.id)}`);
      break;
    }
    let seg = node.tagName + classes.map((c) => '.' + cssEscapeIdent(c)).join('');
    if (classes.length) {
      const count = selectAll(root, seg).length;
      if (count >= 1 && count <= 3) {
        segs.unshift(seg);
        break;
      }
    }
    const parent = node.parent;
    if (parent && parent.children && parent.type === 'element') {
      const same = parent.children.filter((c) => c.tagName === node.tagName && sameClass(c, node));
      if (same.length > 1 && !classes.length) seg += `:nth-child(${parent.children.indexOf(node) + 1})`;
    }
    segs.unshift(seg);
    node = parent;
    depth++;
  }
  return segs.join(' > ');
}

function sameClass(a, b) {
  const ca = (a.classes || []).slice().sort().join('.');
  const cb = (b.classes || []).slice().sort().join('.');
  return ca === cb;
}

/**
 * 把匹配结果按“共同父节点”分组，返回评估得分最高的那一组（真正的列表项）。
 */
function pickBestSiblingGroup(matched) {
  if (matched.length <= 1) return matched;
  const groups = new Map();
  for (const el of matched) {
    const p = el.parent;
    if (!p) continue;
    if (!groups.has(p)) groups.set(p, []);
    groups.get(p).push(el);
  }
  let best = matched;
  let bestScore = -Infinity;
  for (const [, list] of groups) {
    const score = evaluateListItems(list) + Math.min(list.length, 60) * 0.05;
    if (score > bestScore) { bestScore = score; best = list; }
  }
  return best;
}

/** 尽量短的路径（用于详情页字段） */
function cssPath(el, root, opts = {}) {
  return simpleCssPath(el, root, opts.maxDepth || 4) || el.tagName;
}

function looksLikeBookItem(el) {
  if (!el || el.type !== 'element') return 0;
  const links = selectAll(el, 'a[href]');
  if (!links.length) return 0;
  const text = el.text.trim();
  if (text.length < 4 || text.length > 400) return 0;
  let score = 0;
  if (links.length >= 1) score += 1;
  if (links.length <= 4) score += 1;
  if (selectAll(el, 'img').length) score += 2;
  if (/(作者|字数|状态|最新章节|简介)/.test(text)) score += 2;
  const href = links.map((a) => a.attr('href')).join(' ');
  if (/\/\d+\/\d+\/?$|\/book\/|\/novel\/|\/read\/|\/info/.test(href)) score += 2;
  return score;
}

/**
 * 找到页面中重复出现的“兄弟结构”，作为列表项候选。
 * 返回 [{ selector, items, score, sample }]
 */
function findListCandidates(doc, opts = {}) {
  const minItems = opts.minItems || 3;
  const results = [];
  const seen = new Set();
  const all = selectAll(doc, '*');
  // 统计父节点下同 tag+class 组合的出现次数
  const parentMap = new Map();
  for (const el of all) {
    const parent = el.parent;
    if (!parent || parent.type !== 'element') continue;
    const sig = el.tagName + '|' + (el.classes || []).slice().sort().join('.');
    if (!parentMap.has(parent)) parentMap.set(parent, new Map());
    const m = parentMap.get(parent);
    if (!m.has(sig)) m.set(sig, []);
    m.get(sig).push(el);
  }
  for (const [parent, sigMap] of parentMap) {
    for (const [sig, items] of sigMap) {
      if (items.length < minItems) continue;
      // 评分：条目像书 + 数量适中
      let itemScore = 0;
      for (const it of items.slice(0, 6)) itemScore += looksLikeBookItem(it);
      if (itemScore <= 0) continue;
      const score = itemScore / Math.min(6, items.length) + Math.min(items.length, 30) / 30;
      const [tag, cls] = sig.split('|');
      const classList = cls ? cls.split('.').filter(Boolean) : [];
      const classPart = classList.map((c) => '.' + cssEscapeIdent(c)).join('');
      const leaf = tag + classPart;
      // 候选选择器：带 class 的叶子 → 带 class 的父路径 → 完整路径
      const candidates = [];
      if (classList.length && !/^\d/.test(classList[0])) candidates.push(leaf);
      const parentSel = simpleCssPath(parent, doc);
      if (parentSel) {
        candidates.push(parentSel + ' > ' + leaf);
        candidates.push(parentSel + ' ' + leaf);
      }
      // 若条目自身带 class，也可用 “父级 class + 后代 tag.class”
      const parentClasses = (parent.classes || []).filter((c) => c && !/^\d/.test(c));
      if (parentClasses.length && classList.length) {
        const p2 = parent.tagName + parentClasses.map((c) => '.' + cssEscapeIdent(c)).join('');
        candidates.push(p2 + ' ' + leaf);
      }
      candidates.push(cssPath(parent, doc) + ' > ' + leaf);
      let selector = null;
      let bestEval = null;
      for (const cand of candidates) {
        if (!cand) continue;
        let matched;
        try { matched = selectAll(doc, cand); } catch (e) { continue; }
        if (!matched.length) continue;
        const picked = pickBestSiblingGroup(matched);
        if (!picked.length) continue;
        const score = evaluateListItems(picked);
        if (!bestEval || score > bestEval.score) bestEval = { score, selector: cand, matched: picked };
      }
      if (!bestEval) continue;
      selector = bestEval.selector;
      const finalItems = bestEval.matched;
      if (seen.has(selector)) continue;
      seen.add(selector);
      results.push({
        selector,
        legadoSelector: `@css:${selector}`,
        count: finalItems.length,
        globalCount: finalItems.length,
        score: score + bestEval.score,
        items: finalItems,
        sample: finalItems.slice(0, 3).map((it) => ({
          text: it.text.trim().slice(0, 60),
          href: (selectAll(it, 'a[href]')[0] || { attr: () => '' }).attr('href'),
        })),
      });
    }
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, 12);
}

/** 目录候选：链接文本像章节名 */
function findChapterListCandidates(doc, opts = {}) {
  const candidates = findListCandidates(doc, { minItems: opts.minItems || 5 });
  const scored = [];
  for (const c of candidates) {
    let chapterHits = 0;
    for (const it of c.items.slice(0, 40)) {
      const a = selectAll(it, 'a[href]')[0];
      const name = (a ? a.text : it.text).trim();
      if (LINK_TEXT_RE.test(name) || (name.length > 1 && name.length < 40)) chapterHits++;
    }
    const hitRatio = chapterHits / Math.max(1, Math.min(40, c.items.length));
    const linkRatio = c.items.filter((it) => selectAll(it, 'a[href]').length).length / c.items.length;
    if (linkRatio < 0.6) continue;
    scored.push(Object.assign({}, c, {
      chapterScore: hitRatio * linkRatio * (1 + Math.min(c.items.length, 200) / 200),
    }));
  }
  scored.sort((a, b) => b.chapterScore - a.chapterScore);
  return scored.slice(0, 8);
}

/** 正文候选：文本密度最高的容器 */
function findContentCandidates(doc, opts = {}) {
  const all = selectAll(doc, 'div,article,section,td');
  const results = [];
  for (const el of all) {
    const text = el.text.replace(/\s+/g, '');
    if (text.length < (opts.minLength || 300)) continue;
    // 链接文本占比过高则跳过
    const links = selectAll(el, 'a');
    let linkText = 0;
    for (const a of links) linkText += a.text.replace(/\s+/g, '').length;
    const linkRatio = linkText / Math.max(1, text.length);
    if (linkRatio > 0.25) continue;
    const pCount = selectAll(el, 'p,br').length;
    const density = text.length / Math.max(1, selectAll(el, '*').length);
    const score = text.length * (1 - linkRatio) + pCount * 30 + density * 0.5;
    results.push({
      selector: cssPath(el, doc),
      textLength: text.length,
      linkRatio: Number(linkRatio.toFixed(3)),
      paragraphs: pCount,
      score,
      preview: text.slice(0, 80),
    });
  }
  results.sort((a, b) => b.score - a.score);
  // 去掉被其他候选包含的（保留最内层高密度容器）
  const filtered = [];
  for (const r of results) {
    if (filtered.some((f) => f.textLength >= r.textLength && f.preview.startsWith(r.preview.slice(0, 20)))) continue;
    filtered.push(r);
    if (filtered.length >= 6) break;
  }
  return filtered;
}

/** 找出搜索表单 */
function findSearchForms(doc, baseUrl) {
  const forms = selectAll(doc, 'form');
  const out = [];
  for (const f of forms) {
    const inputs = selectAll(f, 'input');
    const action = f.attr('action') || '';
    const method = (f.attr('method') || 'GET').toUpperCase();
    const params = [];
    for (const inp of inputs) {
      const name = inp.attr('name');
      const type = (inp.attr('type') || 'text').toLowerCase();
      if (!name) continue;
      if (['submit', 'button', 'image', 'reset'].includes(type)) continue;
      params.push({ name, type, value: inp.attr('value') });
    }
    if (!params.length) continue;
    out.push({ action: absUrl(baseUrl, action) || baseUrl, method, params, html: outerHtml(f).slice(0, 300) });
  }
  // 页面里的搜索链接（如 /search.php?q=）
  const links = selectAll(doc, 'a[href]');
  for (const a of links) {
    const href = a.attr('href');
    if (/search|so\.php|s\?|find/i.test(href) && /[?&](q|key|keyword|wd|searchkey|kw)=/.test(href)) {
      out.push({ action: absUrl(baseUrl, href.split('?')[0]), method: 'GET', params: [{ name: (href.match(/[?&](q|key|keyword|wd|searchkey|kw)=/) || [])[1] || 'q', type: 'text' }], inferFromLink: true });
    }
  }
  return out;
}

/** JSON 接口嗅探：找到数组型结果 */
function findJsonListCandidates(json) {
  const results = [];
  const walk = (node, path, depth) => {
    if (depth > 5) return;
    if (Array.isArray(node) && node.length >= 3) {
      const first = node[0];
      if (first && typeof first === 'object' && !Array.isArray(first)) {
        const keys = Object.keys(first);
        let score = 0;
        if (keys.some((k) => /name|title|book/i.test(k))) score += 3;
        if (keys.some((k) => /author|actor|writer/i.test(k))) score += 2;
        if (keys.some((k) => /url|link|href|id/i.test(k))) score += 2;
        if (keys.some((k) => /pic|cover|img/i.test(k))) score += 1;
        score += Math.min(node.length, 50) / 50;
        results.push({ path: path || '$', count: node.length, keys, score });
      }
    }
    if (node && typeof node === 'object' && !Array.isArray(node)) {
      for (const [k, v] of Object.entries(node)) {
        walk(v, path ? `${path}.${k}` : k, depth + 1);
      }
    }
  };
  walk(json, '', 0);
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, 6);
}

/** 根据 JSON 列表项猜测字段规则 */
function guessJsonFieldRules(keys) {
  const pick = (re) => keys.find((k) => re.test(k));
  const rules = {};
  const name = pick(/^(name|title|bookname|book_name|articlename)$/i) || pick(/name|title/i);
  const author = pick(/author|actor|writer|auth/i);
  const url = pick(/^(url|link|href|bookurl|book_url)$/i) || pick(/url|link/i);
  const cover = pick(/pic|cover|img|image/i);
  const intro = pick(/intro|desc|blurb|summary|content/i);
  const kind = pick(/class|kind|category|type/i);
  const last = pick(/lastchapter|latest|last_chapter|remarks/i);
  if (name) rules.name = `$.${name}`;
  if (author) rules.author = `$.${author}`;
  if (url) rules.bookUrl = `$.${url}`;
  if (cover) rules.coverUrl = `$.${cover}`;
  if (intro) rules.intro = `$.${intro}`;
  if (kind) rules.kind = `$.${kind}`;
  if (last) rules.lastChapter = `$.${last}`;
  return rules;
}

/** 在页面所有链接中找“书籍详情页”模式 */
function detectBookUrlPattern(html, baseUrl) {
  const doc = typeof html === 'string' ? parseHtml(html) : html;
  const links = selectAll(doc, 'a[href]');
  const patterns = new Map();
  for (const a of links) {
    const href = absUrl(baseUrl, a.attr('href'));
    if (!href || !/^https?:/i.test(href)) continue;
    try {
      const u = new URL(href);
      const parts = u.pathname.split('/').filter(Boolean);
      if (!parts.length) continue;
      // 形如 /6/6452/ 或 /book/1234 或 /novel/xxx/123
      let sig = parts.map((p) => (/^\d+$/.test(p) ? '\\d+' : (/^[a-z]+$/i.test(p) ? p : '\\w+'))).join('/');
      const full = `^https?://${u.host.replace(/\./g, '\\.')}/${sig}/?$`;
      patterns.set(full, (patterns.get(full) || 0) + 1);
    } catch (e) { /* ignore */ }
  }
  const sorted = [...patterns.entries()].sort((a, b) => b[1] - a[1]);
  return sorted.length ? { pattern: sorted[0][0], count: sorted[0][1], all: sorted.slice(0, 5) } : null;
}

// ---------------- 字段规则探测（基于候选规则的实测打分） ----------------

const FIELD_PROBES = {
  name: ['h3 a@text', 'h4 a@text', 'h2 a@text', '.bookname a@text', '.title a@text', 'dt a@text',
    'a[href]@text', 'a[title]@title', '.name@text', 'h3@text', 'a@text'],
  author: ['dd.book_other span.0@text', 'dd.book_other span@text', '.author@text', 'span.author@text',
    'p.author@text', 'dd.author@text', '.bookinfo@text', 'span@text', 'dd.0@text', 'dd@text', 'p@text'],
  coverUrl: ['dt img@src', 'img@src', 'img@data-src', 'img@data-original'],
  intro: ['.intro@text', 'p.intro@text', '.bookintro@text', '.desc@text', '#intro@text',
    '.book_other.intro@text', 'p@text', 'dd@text'],
  kind: ['.book_other.1@text', 'dd.book_other.0@text', '.kind@text', '.category@text', 'span.cat@text', 'span.tag@text'],
  lastChapter: ['dd.book_other.-1@text', 'dd.book_other a@text', '.lastchapter a@text', '.chapter a@text',
    'a.chapter@text', 'dd a@text'],
  wordCount: ['.wordcount@text', 'span.word@text', '.size@text', '.book_other.2@text'],
};

// bookUrl 专用候选（第一个链接优先）
const BOOKURL_PROBES = [
  'dt a.0@href', 'h3 a.0@href', 'h4 a.0@href', '.title a.0@href',
  'a[href].0@href', 'dt a@href', 'h3 a@href', 'h4 a@href', '.title a@href', 'a[href]@href',
];

const FIELD_REJECT = {
  name: (v) => !v || v.length > 60,
  author: (v) => !v || v.length > 20 || /状态|更新|章节|字数|分类/.test(v) || /^\[.+\]/.test(v),
  intro: (v) => !v || v.length < 4 || v.length > 400,
  kind: (v) => !v || v.length > 30 || /作者|状态|更新|最新章节/.test(v),
  lastChapter: (v) => !v || v.length > 60,
  wordCount: (v) => !/[\d万亿]/.test(v) || v.length > 20 || v.includes('\n'),
  coverUrl: (v) => !/\.(jpg|jpeg|png|webp|gif|bmp)|^data:image/i.test(v),
};

/** 把候选规则跑在每个条目上（选择器部分作用于条目，最后一段作为取值操作） */
function evalRulePerItem(rule, it, AnalyzeRuleCls, baseUrl) {
  const s = String(rule || '');
  const at = s.lastIndexOf('@');
  if (at <= 0) {
    try {
      const a = new AnalyzeRuleCls({ content: it, baseUrl });
      return String(a.getString(s) || '').trim();
    } catch (e) { return ''; }
  }
  const sel = s.slice(0, at);
  const op = s.slice(at + 1);
  try {
    const selAnalyzer = new AnalyzeRuleCls({ content: it, baseUrl });
    const els = selAnalyzer.getElements(sel);
    // 选择器没有命中时，legado/本引擎会退化为“上下文节点本身”，
    // 这会让字段拿到整段文本，必须在探测阶段识别并丢弃。
    if (els.length === 1 && (els[0] === it || els[0] === selAnalyzer.node)) return '';
    if (!els.length) return '';
    const values = [];
    for (const el of els) {
      const a = new AnalyzeRuleCls({ content: el, baseUrl });
      const v = a.getString(op);
      if (v !== undefined && v !== null && String(v) !== '') values.push(String(v));
    }
    return values.join(' / ');
  } catch (e) {
    return '';
  }
}

/**
 * 为列表字段挑选最佳规则：逐个候选规则在真实条目上跑，按覆盖率与合理性打分。
 */
function probeFieldRules(items, pageUrl, AnalyzeRuleCls, baseUrl) {
  const rules = {};
  const details = {};
  const maxN = Math.min(items.length, 5);
  for (const [field, probes] of Object.entries(FIELD_PROBES)) {
    let best = null;
    for (const probe of probes) {
      const values = [];
      let used = 0;
      for (const it of items.slice(0, maxN)) {
        const v = evalRulePerItem(probe, it, AnalyzeRuleCls, baseUrl || pageUrl);
        values.push(v);
        if (v) used++;
      }
      const coverage = used / maxN;
      if (coverage < 0.6) continue;
      // 一个条目里抓到多个值（用 ' / ' 连接）通常说明选择器太宽
      if (values.filter((v) => v.includes(' / ')).length > maxN * 0.5) continue;
      const reject = FIELD_REJECT[field];
      const okValues = values.filter((v) => v && !(reject && reject(v)));
      if (okValues.length / maxN < 0.6) continue;
      if (field !== 'kind' && new Set(okValues).size < Math.min(2, okValues.length)) continue;
      const score = coverage * 2 + (okValues.length / maxN) * 2 - probe.length * 0.01;
      if (!best || score > best.score) {
        best = { rule: probe, score, values: okValues.slice(0, 3), coverage };
      }
    }
    if (best) {
      rules[field] = best.rule;
      details[field] = { rule: best.rule, coverage: Number(best.coverage.toFixed(2)), sample: best.values };
    }
  }
  // 字段互斥：作者/分类/字数不应与书名取了同一段文本
  const nameSample = details.name && details.name.sample;
  if (nameSample && nameSample.length) {
    for (const field of ['author', 'kind', 'wordCount', 'lastChapter', 'intro']) {
      const d = details[field];
      if (!d || !d.sample.length) continue;
      const same = d.sample.filter((v) => nameSample.includes(v)).length;
      if (same >= Math.min(2, d.sample.length)) {
        delete rules[field];
        delete details[field];
      }
    }
  }
  return { rules, details };
}

/** 从条目里挑出书链接规则 */
function probeBookUrlRule(items, pageUrl, AnalyzeRuleCls) {
  let best = null;
  const maxN = Math.min(items.length, 5);
  for (const probe of BOOKURL_PROBES) {
    const values = [];
    for (const it of items.slice(0, maxN)) {
      const v = evalRulePerItem(probe, it, AnalyzeRuleCls, pageUrl);
      if (v && !/^javascript:/i.test(v)) values.push(v);
    }
    if (!values.length) continue;
    const coverage = values.length / maxN;
    const quality = values.filter((v) => /^https?:|^\//.test(v)).length / values.length;
    if (quality < 0.6) continue;
    const score = coverage * 2 + quality;
    if (!best || score > best.score) best = { rule: probe, coverage, quality, score, sample: values.slice(0, 3) };
  }
  return best;
}

module.exports = {
  cssPath, simpleCssPath, findListCandidates, findChapterListCandidates, findContentCandidates,
  findSearchForms, findJsonListCandidates, guessJsonFieldRules, detectBookUrlPattern,
  looksLikeBookItem, LINK_TEXT_RE, outerHtml, probeFieldRules, probeBookUrlRule,
  FIELD_PROBES, evaluateListItems, evalRulePerItem, pickBestSiblingGroup, BOOKURL_PROBES, isBookLikeHref,
};
