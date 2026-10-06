'use strict';
/**
 * CSS 选择器子集实现（够用于 Legado 书源的 @css: 规则与自动嗅探）。
 * 支持：标签 / * / #id / .class / [attr] / [attr=v] / [attr~=v] / [attr^=] / [$=] / [*=]
 *      / [attr!=v]、后代、>、+、~、伪类 :first-child/:last-child/:nth-child(n)/:not(简单选择器)
 *      / :eq(n) / :lt(n) / :gt(n)（jQuery 风格，方便自动生成规则）
 */

const { Element } = require('./dom');

function parseSimpleSelector(text) {
  const sel = { tag: null, id: null, classes: [], attrs: [], pseudos: [] };
  let i = 0;
  const re = /([#.]?[\w\u00a0-\uffff-]+)|(\[[^\]]*\])|(:[\w-]+(?:\([^)]*\))?)|(\*)/g;
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(text)) !== null) {
    const tok = m[0];
    if (tok === '*') { sel.tag = '*'; continue; }
    if (tok[0] === '#') { sel.id = tok.slice(1); continue; }
    if (tok[0] === '.') { sel.classes.push(tok.slice(1)); continue; }
    if (tok[0] === '[') {
      const body = tok.slice(1, -1);
      const am = body.match(/^([\w\u00a0-\uffff-]+)\s*(?:([~^$*!]?=)\s*(.*?)\s*)?$/);
      if (am) sel.attrs.push({ name: am[1].toLowerCase(), op: am[2] || null, value: unquote(am[3]) });
      continue;
    }
    if (tok[0] === ':') {
      const pm = tok.match(/^:([\w-]+)(?:\((.*)\))?$/);
      if (pm) sel.pseudos.push({ name: pm[1].toLowerCase(), arg: pm[2] });
      continue;
    }
    sel.tag = tok.toLowerCase();
  }
  return sel;
}

function unquote(s) {
  if (s === undefined) return '';
  s = String(s).trim();
  if ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'"))) return s.slice(1, -1);
  return s;
}

function parseSelector(selector) {
  const groups = [];
  let cur = '';
  let depth = 0;
  let mode = 'desc';
  let parts = [];
  const flush = () => {
    if (cur.trim()) parts.push({ combinator: mode, sel: parseSimpleSelector(cur.trim()) });
    cur = '';
  };
  const s = String(selector).trim();
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '[') depth++;
    if (c === ']') depth--;
    if (depth === 0) {
      if (/\s/.test(c)) {
        // 看后面是否有组合符
        let j = i;
        while (j < s.length && /\s/.test(s[j])) j++;
        if (s[j] === '>' || s[j] === '+' || s[j] === '~') { flush(); mode = s[j]; i = j; continue; }
        if (cur.trim()) { flush(); mode = 'desc'; }
        continue;
      }
      if (c === '>' || c === '+' || c === '~') {
        flush();
        mode = c;
        continue;
      }
      if (c === ',') {
        flush();
        groups.push(parts);
        parts = [];
        mode = 'desc';
        continue;
      }
    }
    cur += c;
  }
  flush();
  if (parts.length) groups.push(parts);
  return groups;
}

function matchSimple(el, sel) {
  if (el.type !== 'element') return false;
  if (sel.tag && sel.tag !== '*' && el.tagName !== sel.tag) return false;
  if (sel.id && el.id !== sel.id) return false;
  for (const c of sel.classes) if (!el.classes.includes(c)) return false;
  for (const a of sel.attrs) {
    const v = el.attr(a.name);
    switch (a.op) {
      case null: if (!el.hasAttr(a.name)) return false; break;
      case '=': if (v !== a.value) return false; break;
      case '~=': if (!v.split(/\s+/).includes(a.value)) return false; break;
      case '^=': if (!v.startsWith(a.value)) return false; break;
      case '$=': if (!v.endsWith(a.value)) return false; break;
      case '*=': if (!v.includes(a.value)) return false; break;
      case '!=': if (v === a.value) return false; break;
      default: break;
    }
  }
  return true;
}

function applyPseudo(list, pseudo, el) {
  const { name, arg } = pseudo;
  switch (name) {
    case 'first-child': {
      const parent = el.parent;
      if (!parent) return false;
      const sibs = parent.children;
      return sibs.indexOf(el) === 0;
    }
    case 'last-child': {
      const parent = el.parent;
      if (!parent) return false;
      const sibs = parent.children;
      return sibs.indexOf(el) === sibs.length - 1;
    }
    case 'nth-child': {
      const parent = el.parent;
      if (!parent) return false;
      const idx = parent.children.indexOf(el) + 1;
      return matchNth(idx, arg);
    }
    case 'first-of-type': {
      const parent = el.parent;
      if (!parent) return false;
      return parent.children.filter((c) => c.tagName === el.tagName).indexOf(el) === 0;
    }
    case 'last-of-type': {
      const parent = el.parent;
      if (!parent) return false;
      const same = parent.children.filter((c) => c.tagName === el.tagName);
      return same.indexOf(el) === same.length - 1;
    }
    case 'not': {
      const inner = parseSimpleSelector(arg || '');
      return !matchSimple(el, inner);
    }
    case 'contains': {
      return el.text.includes(unquote(arg));
    }
    case 'eq': {
      return list.indexOf(el) === Number(arg);
    }
    case 'lt': {
      return list.indexOf(el) < Number(arg);
    }
    case 'gt': {
      return list.indexOf(el) > Number(arg);
    }
    case 'empty': {
      return el.children.length === 0 && !el.text.trim();
    }
    default:
      return true;
  }
}

function matchNth(idx, arg) {
  const a = String(arg || '').trim().toLowerCase();
  if (a === 'odd') return idx % 2 === 1;
  if (a === 'even') return idx % 2 === 0;
  const m = a.match(/^([+-]?\d*)n\s*([+-]\s*\d+)?$/);
  if (m) {
    const coef = m[1] === '' || m[1] === '+' ? 1 : (m[1] === '-' ? -1 : parseInt(m[1], 10));
    const b = m[2] ? parseInt(m[2].replace(/\s/g, ''), 10) : 0;
    if (coef === 0) return idx === b;
    const k = (idx - b) / coef;
    return Number.isInteger(k) && k >= 0;
  }
  return idx === parseInt(a, 10);
}

function descendants(root) {
  const out = [];
  const walk = (node) => {
    for (const child of node.children) {
      out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}

function selectAll(root, selector) {
  const groups = parseSelector(selector);
  const results = [];
  const seen = new Set();
  for (const parts of groups) {
    let current = [root];
    for (const part of parts) {
      const next = [];
      for (const ctx of current) {
        if (part.combinator === '>') {
          for (const c of ctx.children) if (matchSimple(c, part.sel)) next.push(c);
        } else if (part.combinator === '+') {
          const sib = ctx.nextElementSibling;
          if (sib && matchSimple(sib, part.sel)) next.push(sib);
        } else if (part.combinator === '~') {
          let sib = ctx.nextElementSibling;
          while (sib) {
            if (matchSimple(sib, part.sel)) next.push(sib);
            sib = sib.nextElementSibling;
          }
        } else {
          const scope = ctx.type === 'document' ? ctx.root : ctx;
          const cands = ctx === root && root.type !== 'document' && root.type !== 'element'
            ? descendants(scope) : descendants(scope);
          for (const c of cands) if (matchSimple(c, part.sel)) next.push(c);
        }
      }
      current = next;
    }
    // 伪类过滤（需要同级/位置信息）
    const pseudos = parts.length ? parts[parts.length - 1].sel.pseudos : [];
    let filtered = current;
    for (const p of pseudos) {
      if (p.name === 'eq' || p.name === 'lt' || p.name === 'gt') {
        if (p.name === 'eq') filtered = filtered.filter((e) => filtered.indexOf(e) === Number(p.arg));
        if (p.name === 'lt') filtered = filtered.filter((e) => filtered.indexOf(e) < Number(p.arg));
        if (p.name === 'gt') filtered = filtered.filter((e) => filtered.indexOf(e) > Number(p.arg));
      } else if (p.name === 'not' || p.name === 'contains' || p.name === 'empty'
        || p.name === 'first-child' || p.name === 'last-child' || p.name === 'nth-child'
        || p.name === 'first-of-type' || p.name === 'last-of-type') {
        filtered = filtered.filter((e) => applyPseudo(filtered, p, e));
      }
    }
    for (const el of filtered) {
      if (!seen.has(el)) { seen.add(el); results.push(el); }
    }
  }
  return results;
}

function selectFirst(root, selector) {
  const all = selectAll(root, selector);
  return all.length ? all[0] : null;
}

module.exports = { selectAll, selectFirst, parseSelector, parseSimpleSelector, matchSimple };
