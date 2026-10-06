'use strict';
/**
 * JSONPath 子集实现（Legado @json: / $. 规则使用）。
 * 支持：$.a.b、$['a']、$..a、[*]、数组下标（含负数）、[start:end:step]、
 *      [?(过滤表达式)]（@.x == 1 / @.x =~ /regex/ / && / || / < > <= >= !=）、[a,b] 联合。
 */

function tokenize(expr) {
  const tokens = [];
  let i = 0;
  const s = expr.trim();
  if (s[0] === '$') { tokens.push({ type: 'root' }); i = 1; } else if (s[0] === '@') {
    tokens.push({ type: 'current' }); i = 1;
  }
  while (i < s.length) {
    const c = s[i];
    if (c === '.') {
      if (s[i + 1] === '.') {
        tokens.push({ type: 'recursive' });
        i += 2;
        if (s[i] === '*') { tokens.push({ type: 'wildcard' }); i++; }
        else {
          const m = /^[^.[\]]+/.exec(s.slice(i));
          if (m) { tokens.push({ type: 'child', name: m[0] }); i += m[0].length; }
        }
        continue;
      }
      i++;
      if (s[i] === '*') { tokens.push({ type: 'wildcard' }); i++; continue; }
      const m = /^[^.[\]]+/.exec(s.slice(i));
      if (m) {
        const raw = m[0];
        if (raw === 'length' || raw === 'size()') tokens.push({ type: 'length' });
        else tokens.push({ type: 'child', name: raw });
        i += raw.length;
      }
      continue;
    }
    if (c === '[') {
      const end = findBracketEnd(s, i);
      const body = s.slice(i + 1, end).trim();
      tokens.push(parseBracket(body));
      i = end + 1;
      continue;
    }
    // 裸属性名（如 @json:a.b 未以 $ 开头）
    const m = /^[^.[\]]+/.exec(s.slice(i));
    if (m) {
      if (m[0] === 'length') tokens.push({ type: 'length' });
      else tokens.push({ type: 'child', name: m[0] });
      i += m[0].length;
      continue;
    }
    break;
  }
  return tokens;
}

function findBracketEnd(s, start) {
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === '[') depth++;
    else if (s[i] === ']') { depth--; if (depth === 0) return i; }
  }
  return s.length - 1;
}

function parseBracket(body) {
  if (body === '*') return { type: 'wildcard' };
  if (body.startsWith('?')) return { type: 'filter', expr: body.replace(/^\?\(?/, '').replace(/\)$/, '') };
  if (body.startsWith("'") || body.startsWith('"')) {
    const parts = splitTop(body).map((p) => p.trim().replace(/^['"]|['"]$/g, ''));
    if (parts.length > 1) return { type: 'union', names: parts };
    return { type: 'child', name: parts[0] };
  }
  // 切片或索引
  if (body.includes(':') && !body.includes(',')) {
    const [a, b, c] = body.split(':').map((x) => x.trim());
    return { type: 'slice', start: a === '' ? null : Number(a), end: b === '' ? null : Number(b), step: c === '' || c === undefined ? 1 : Number(c) };
  }
  if (body.includes(',')) {
    const parts = body.split(',').map((x) => x.trim());
    if (parts.every((p) => /^-?\d+$/.test(p))) return { type: 'indexes', indexes: parts.map(Number) };
    return { type: 'union', names: parts.map((p) => p.replace(/^['"]|['"]$/g, '')) };
  }
  if (/^-?\d+$/.test(body)) return { type: 'index', index: Number(body) };
  return { type: 'child', name: body.replace(/^['"]|['"]$/g, '') };
}

function splitTop(s, sep = ',') {
  const out = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '[' || c === '(') depth++;
    if (c === ']' || c === ')') depth--;
    if (c === sep && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

function recursiveValues(node, out = []) {
  if (Array.isArray(node)) {
    for (const v of node) { out.push(v); recursiveValues(v, out); }
  } else if (node && typeof node === 'object') {
    for (const k of Object.keys(node)) { out.push(node[k]); recursiveValues(node[k], out); }
  }
  return out;
}

function evalFilter(node, expr) {
  if (!node || typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.some((v) => evalFilter(v, expr));
  const orParts = splitLogical(expr, '||');
  if (orParts.length > 1) return orParts.some((p) => evalFilter(node, p));
  const andParts = splitLogical(expr, '&&');
  if (andParts.length > 1) return andParts.every((p) => evalFilter(node, p));
  const cmp = expr.match(/^(@\.[\w.$[\]'"]*|@)\s*(==|!=|<=|>=|<|>|=~|!~)\s*(.+)$/);
  if (cmp) {
    const left = cmp[1] === '@' ? node : getPath(node, cmp[1].slice(2));
    const rightRaw = cmp[3].trim();
    let right;
    if (/^\/.*\/[a-z]*$/.test(rightRaw)) {
      const m = rightRaw.match(/^\/(.*)\/([a-z]*)$/);
      const re = new RegExp(m[1], m[2]);
      if (cmp[2] === '=~') return typeof left === 'string' && re.test(left);
      if (cmp[2] === '!~') return !(typeof left === 'string' && re.test(left));
    }
    if (rightRaw.startsWith('@.')) right = getPath(node, rightRaw.slice(2));
    else if (/^-?\d+(\.\d+)?$/.test(rightRaw)) right = Number(rightRaw);
    else if (rightRaw === 'true') right = true;
    else if (rightRaw === 'false') right = false;
    else if (rightRaw === 'null') right = null;
    else right = rightRaw.replace(/^['"]|['"]$/g, '');
    switch (cmp[2]) {
      case '==': return String(left) === String(right);
      case '!=': return String(left) !== String(right);
      case '<': return Number(left) < Number(right);
      case '>': return Number(left) > Number(right);
      case '<=': return Number(left) <= Number(right);
      case '>=': return Number(left) >= Number(right);
      default: return false;
    }
  }
  // 存在性判断 @.name
  const ex = expr.match(/^@\.([\w.$]+)$/);
  if (ex) return getPath(node, ex[1]) !== undefined;
  return false;
}

function splitLogical(expr, op) {
  const out = [];
  let depth = 0;
  let inStr = false;
  let cur = '';
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (c === "'" || c === '"') inStr = !inStr;
    if (!inStr) {
      if (c === '(' || c === '[') depth++;
      if (c === ')' || c === ']') depth--;
      if (depth === 0 && expr.startsWith(op, i)) {
        out.push(cur);
        cur = '';
        i += op.length - 1;
        continue;
      }
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

function getPath(obj, path) {
  if (!path) return obj;
  const tokens = tokenize('$.' + path.replace(/^\$\.?/, ''));
  const res = queryTokens(tokens.slice(1), obj);
  return res[0];
}

function queryTokens(tokens, root) {
  let current = [root];
  for (const t of tokens) {
    const next = [];
    for (const node of current) {
      switch (t.type) {
        case 'root': next.push(root); break;
        case 'current': next.push(node); break;
        case 'child':
          if (node && typeof node === 'object' && t.name in node) next.push(node[t.name]);
          break;
        case 'index': {
          if (Array.isArray(node)) {
            const i = t.index < 0 ? node.length + t.index : t.index;
            if (i >= 0 && i < node.length) next.push(node[i]);
          }
          break;
        }
        case 'indexes':
          if (Array.isArray(node)) {
            for (const idx of t.indexes) {
              const i = idx < 0 ? node.length + idx : idx;
              if (i >= 0 && i < node.length) next.push(node[i]);
            }
          }
          break;
        case 'slice':
          if (Array.isArray(node)) {
            const step = t.step || 1;
            const len = node.length;
            let start = t.start === null ? (step > 0 ? 0 : len - 1) : (t.start < 0 ? len + t.start : t.start);
            let end = t.end === null ? (step > 0 ? len : -1) : (t.end < 0 ? len + t.end : t.end);
            if (step > 0) {
              for (let i = start; i < end; i += step) if (i >= 0 && i < len) next.push(node[i]);
            } else {
              for (let i = start; i > end; i += step) if (i >= 0 && i < len) next.push(node[i]);
            }
          }
          break;
        case 'wildcard':
          if (Array.isArray(node)) next.push(...node);
          else if (node && typeof node === 'object') next.push(...Object.values(node));
          break;
        case 'recursive':
          recursiveValues(node, next);
          break;
        case 'union':
          if (node && typeof node === 'object') {
            if (Array.isArray(node)) {
              for (const n of t.names) if (/^-?\d+$/.test(n)) { const i = Number(n); const idx = i < 0 ? node.length + i : i; if (node[idx] !== undefined) next.push(node[idx]); }
            } else {
              for (const n of t.names) if (n in node) next.push(node[n]);
            }
          }
          break;
        case 'filter':
          if (Array.isArray(node)) for (const v of node) if (evalFilter(v, t.expr)) next.push(v);
          else if (node && typeof node === 'object') for (const v of Object.values(node)) if (evalFilter(v, t.expr)) next.push(v);
          break;
        case 'length':
          if (Array.isArray(node)) next.push(node.length);
          else if (node && typeof node === 'object') next.push(Object.keys(node).length);
          else if (typeof node === 'string') next.push(node.length);
          break;
        default: break;
      }
    }
    current = next;
  }
  return current;
}

function jsonPathQuery(json, expr) {
  let e = String(expr).trim();
  if (e.startsWith('@json:')) e = e.slice(6).trim();
  const tokens = tokenize(e);
  return queryTokens(tokens.filter((t) => t.type !== 'root'), json);
}

module.exports = { jsonPathQuery, tokenize, queryTokens, evalFilter };
