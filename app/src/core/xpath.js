'use strict';
/**
 * XPath 1.0 子集实现（Legado @XPath: / // 规则使用）。
 * 支持：//tag、/tag、*、@attr、text()、[n]、[last()]、[@attr]、[@attr='v']、
 *      [contains(@a,'v')]、[text()='v']、[starts-with(...)]、多级路径、| 联合。
 * 以 HTML 节点树为上下文（与 jsoup 类似，XPath 的层级即 DOM 层级）。
 */

const { Element, TextNode, Document } = require('./dom');

function parsePath(path) {
  const steps = [];
  let i = 0;
  const s = path.trim();
  let first = true;
  while (i < s.length) {
    const c = s[i];
    if (c === '/') {
      const descendant = s[i + 1] === '/';
      i += descendant ? 2 : 1;
      // 读取节点测试 + 谓词
      let j = i;
      let depth = 0;
      while (j < s.length) {
        if (s[j] === '[') depth++;
        if (s[j] === ']') depth--;
        if (depth === 0 && (s[j] === '/' || s[j] === '|')) break;
        j++;
      }
      const body = s.slice(i, j).trim();
      if (body) steps.push(parseStep(body, first && !descendant && s[0] === '/'));
      i = j;
      first = false;
      continue;
    }
    if (c === '|') { i++; first = true; continue; }
    i++;
  }
  return steps;
}

function parseStep(body, absolute) {
  const preds = [];
  let name = body;
  const pi = body.indexOf('[');
  if (pi >= 0) {
    name = body.slice(0, pi);
    let rest = body.slice(pi);
    const re = /\[([^\]]*(?:\[[^\]]*\][^\]]*)*)\]/g;
    let m;
    while ((m = re.exec(rest)) !== null) preds.push(m[1]);
  }
  let axis = 'child';
  let test = name || '*';
  if (test.startsWith('@')) axis = 'attribute';
  if (test === 'text()') axis = 'text';
  if (test.startsWith('..')) { axis = 'parent'; test = '*'; }
  return { axis, test: test.replace(/^@/, ''), preds, absolute: !!absolute, descendant: true };
}

function splitUnion(path) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < path.length; i++) {
    const c = path[i];
    if (c === '[') depth++;
    if (c === ']') depth--;
    if (c === '|' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  parts.push(cur);
  return parts.filter((p) => p.trim());
}

function stepMatches(node, step) {
  if (step.axis === 'text') return node.type === 'text';
  if (node.type !== 'element') {
    if (step.axis === 'attribute') return false;
    return false;
  }
  if (step.test === '*') return true;
  if (step.test === 'node()') return true;
  return node.tagName === step.test.toLowerCase();
}

function readAttr(node, name) {
  if (node.type !== 'element') return undefined;
  return node.hasAttr(name) ? node.attr(name) : undefined;
}

function firstNonEmpty(...vals) {
  for (const v of vals) if (v !== undefined && v !== null && v !== '') return v;
  return undefined;
}

function evalPredicate(node, pred, position, size, ctx) {
  const p = pred.trim();
  if (/^-?\d+$/.test(p)) {
    const n = Number(p);
    return n < 0 ? position === size + n + 1 : position === n;
  }
  if (p === 'last()') return position === size;
  const cmp = p.match(/^(@[\w-]+|text\(\)|\.)\s*(=|!=|<=|>=|<|>)\s*(.+)$/);
  if (cmp) {
    const leftRaw = cmp[1];
    const rightRaw = cmp[3].trim().replace(/^['"]|['"]$/g, '');
    const left = leftRaw === 'text()' ? node.text : leftRaw === '.'
      ? node.text : readAttr(node, leftRaw.slice(1));
    const l = left === undefined ? '' : String(left).trim();
    const r = String(rightRaw).trim();
    switch (cmp[2]) {
      case '=': return l === r;
      case '!=': return l !== r;
      case '<': return Number(l) < Number(r);
      case '>': return Number(l) > Number(r);
      case '<=': return Number(l) <= Number(r);
      case '>=': return Number(l) >= Number(r);
      default: return false;
    }
  }
  const fn = p.match(/^(contains|starts-with|ends-with|normalize-space|not)\s*\((.*)\)$/);
  if (fn) {
    const args = splitArgs(fn[2]);
    const val = (a) => {
      a = a.trim();
      if (a === 'text()' || a === '.') return node.text;
      if (a.startsWith('@')) return readAttr(node, a.slice(1)) || '';
      if (a === 'last()') return size;
      if (a === 'position()') return position;
      return a.replace(/^['"]|['"]$/g, '');
    };
    switch (fn[1]) {
      case 'contains': return String(val(args[0])).includes(String(val(args[1])));
      case 'starts-with': return String(val(args[0])).startsWith(String(val(args[1])));
      case 'ends-with': return String(val(args[0])).endsWith(String(val(args[1])));
      case 'normalize-space': return String(val(args[0])).trim().replace(/\s+/g, ' ').length > 0;
      case 'not': return !evalPredicate(node, args[0], position, size, ctx);
      default: return false;
    }
  }
  if (p.startsWith('@')) return readAttr(node, p.slice(1)) !== undefined;
  if (p === 'text()') return node.type === 'element' && node.text.trim() !== '';
  if (p === 'position()') return true;
  return false;
}

function splitArgs(s) {
  const out = [];
  let depth = 0;
  let cur = '';
  let inStr = false;
  for (const c of s) {
    if (c === "'" || c === '"') inStr = !inStr;
    if (!inStr) {
      if (c === '(') depth++;
      if (c === ')') depth--;
      if (c === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

function allDescendants(node, out = []) {
  for (const c of node.childNodes || []) {
    out.push(c);
    allDescendants(c, out);
  }
  return out;
}

function nodesOf(node) {
  return node.childNodes || [];
}

function evaluateAxis(ctxs, step) {
  const out = [];
  for (const ctx of ctxs) {
    if (step.axis === 'attribute') {
      if (ctx.type !== 'element') continue;
      const el = ctx;
      if (step.test && el.hasAttr(step.test)) out.push({ __attr: el.attr(step.test) });
      continue;
    }
    if (step.axis === 'parent') {
      if (ctx.parent) out.push(ctx.parent);
      continue;
    }
    if (step.axis === 'text') {
      for (const n of nodesOf(ctx)) if (n.type === 'text' && n.text.trim()) out.push(n);
      continue;
    }
    if (step.absolute && !step.descendant) {
      for (const n of nodesOf(ctx)) if (stepMatches(n, step)) out.push(n);
      continue;
    }
    for (const n of allDescendants(ctx)) if (stepMatches(n, step)) out.push(n);
  }
  return out;
}

function applyPreds(list, preds, ctx) {
  let cur = list;
  for (const pred of preds) {
    if (pred.trim().startsWith('@') || pred.trim() === 'text()' || pred.includes('(')) {
      cur = cur.filter((n, i) => evalPredicate(n, pred, i + 1, cur.length, ctx));
    } else {
      cur = cur.filter((n, i) => evalPredicate(n, pred, i + 1, cur.length, ctx));
    }
  }
  return cur;
}

function xpathQuery(root, path) {
  let p = String(path).trim();
  if (p.startsWith('@XPath:')) p = p.slice(7).trim();
  const unions = splitUnion(p);
  const results = [];
  for (const one of unions) {
    let steps = parsePath(one);
    if (!steps.length) continue;
    let ctxs = [root.type === 'document' ? root.root : root];
    // 处理开头的 / 或 //
    const startsWithRoot = one.trim().startsWith('/');
    if (one.trim().startsWith('//')) {
      // 第一步对全树后代匹配
      const firstStep = steps[0];
      const found = allDescendants(ctxs[0]).filter((n) => stepMatches(n, firstStep));
      ctxs = applyPreds(found, firstStep.preds, ctxs[0]);
      steps = steps.slice(1);
    } else if (one.trim().startsWith('/')) {
      const firstStep = steps[0];
      const found = nodesOf(ctxs[0]).filter((n) => stepMatches(n, firstStep));
      ctxs = applyPreds(found, firstStep.preds, ctxs[0]);
      steps = steps.slice(1);
    } else {
      // 相对路径：直接在上下文节点上进行后代匹配
      const firstStep = steps[0];
      const found = allDescendants(ctxs[0]).filter((n) => stepMatches(n, firstStep));
      ctxs = applyPreds(found, firstStep.preds, ctxs[0]);
      steps = steps.slice(1);
    }
    for (const step of steps) {
      let found = evaluateAxis(ctxs, step);
      found = applyPreds(found, step.preds, ctxs);
      ctxs = found;
    }
    results.push(...ctxs);
  }
  return results;
}

function xpathString(root, path) {
  const nodes = xpathQuery(root, path);
  const parts = [];
  for (const n of nodes) {
    if (n && n.__attr !== undefined) parts.push(n.__attr);
    else if (n.type === 'text') parts.push(n.text.trim());
    else if (n.type === 'element') parts.push(n.text.trim());
    else parts.push(String(n));
  }
  return parts;
}

module.exports = { xpathQuery, xpathString, allDescendants };
