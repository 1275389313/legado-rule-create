'use strict';
/**
 * Legado 风格的 HTTP 抓取层。
 * 支持：
 *   url,{ "charset":"gbk", "method":"POST", "body":"...", "headers":{...}, "webView":true, "retry":2 }
 *   url,{"js":"..."} （js 参数在解析 url 时执行）
 *   相对 URL、{{key}}/{{page}} 已在 URL 层替换
 *   编码自动识别（meta charset / Content-Type / BOM），中文站点常见 gbk/gb18030/big5
 */

const zlib = require('zlib');

const DEFAULT_UA = 'Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

const CHARSET_ALIAS = {
  'gb2312': 'gbk', 'gb-2312': 'gbk', 'x-gbk': 'gbk', 'gb_2312-80': 'gbk',
  'utf8': 'utf-8', 'utf-8': 'utf-8', 'unicode-1-1-utf-8': 'utf-8',
  'big-5': 'big5', 'big5-hkscs': 'big5', 'csbig5': 'big5',
  'iso-8859-1': 'windows-1252', 'latin1': 'windows-1252',
};

function normalizeCharset(cs) {
  if (!cs) return null;
  const c = String(cs).trim().toLowerCase().replace(/["']/g, '');
  return CHARSET_ALIAS[c] || c;
}

function decodeBuffer(buf, charset) {
  if (!charset) return buf.toString('utf8');
  try {
    return new TextDecoder(normalizeCharset(charset)).decode(buf);
  } catch (e) {
    return buf.toString('utf8');
  }
}

function sniffCharsetFromBuffer(buf) {
  const head = buf.subarray(0, 4096).toString('latin1');
  const m = head.match(/charset\s*=\s*["']?\s*([\w-]+)/i);
  if (m) return normalizeCharset(m[1]);
  return null;
}

function looksLikeMojibake(text) {
  const bad = (text.match(/\uFFFD/g) || []).length;
  return bad > Math.max(2, text.length * 0.002);
}

/** 从中文站点常见的乱码中恢复：先按 gbk 解码 latin1 再解一次 */
function fixMojibake(text) {
  try {
    const buf = Buffer.from(text, 'latin1');
    const gbk = decodeBuffer(buf, 'gbk');
    const score = (s) => {
      const cjk = (s.match(/[\u4e00-\u9fa5]/g) || []).length;
      const junk = (s.match(/[\uFFFD\u00c0-\u00ff]{2,}/g) || []).length;
      return cjk - junk * 4;
    };
    return score(gbk) > score(text) ? gbk : text;
  } catch (e) {
    return text;
  }
}

class CookieJar {
  constructor() { this.map = new Map(); }
  setFromResponse(url, res) {
    let host = '';
    try { host = new URL(url).hostname; } catch (e) { host = ''; }
    const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    const list = raw.length ? raw : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
    for (const item of list) {
      const kv = String(item).split(';')[0];
      const eq = kv.indexOf('=');
      if (eq <= 0) continue;
      const name = kv.slice(0, eq).trim();
      const value = kv.slice(eq + 1).trim();
      this.map.set(host + '|' + name, value);
    }
  }
  header(url) {
    let host = '';
    try { host = new URL(url).hostname; } catch (e) { host = ''; }
    const parts = [];
    for (const [k, v] of this.map) {
      const [h, name] = k.split('|');
      if (h === host) parts.push(`${name}=${v}`);
    }
    return parts.join('; ');
  }
  get(url, key) {
    let host = '';
    try { host = new URL(url).hostname; } catch (e) { host = ''; }
    if (key) return this.map.get(host + '|' + key) || '';
    return this.header(url);
  }
  toJSON() { return Object.fromEntries(this.map); }
}

/**
 * 解析 legado 的 url 规则： "http://a.com/x,{...}" 或 "http://a.com/x,{...},{\"webView\":true}"
 */
function parseUrlRule(rule) {
  const s = String(rule || '');
  const firstComma = s.indexOf(',');
  if (firstComma === -1) return { url: s.trim(), options: {} };
  const url = s.slice(0, firstComma).trim();
  let rest = s.slice(firstComma + 1).trim();
  let options = {};
  // 多个 JSON 片段拼接的情况：取第一个完整 JSON
  if (rest.startsWith('{')) {
    let depth = 0;
    let end = -1;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '{') depth++;
      if (rest[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    const jsonPart = end === -1 ? rest : rest.slice(0, end + 1);
    try { options = JSON.parse(jsonPart); } catch (e) { options = {}; }
    const tail = end === -1 ? '' : rest.slice(end + 1).replace(/^,\s*/, '');
    if (tail) {
      try { Object.assign(options, JSON.parse(tail)); } catch (e) { /* ignore */ }
    }
  }
  return { url, options };
}

class HttpClient {
  constructor(opts = {}) {
    this.jar = opts.jar || new CookieJar();
    this.timeout = opts.timeout || 20000;
    this.log = opts.log || (() => {});
    this.maxRedirects = 5;
    this.defaultHeaders = Object.assign({
      'User-Agent': DEFAULT_UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    }, opts.headers || {});
  }

  async request(url, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    const headers = Object.assign({}, this.defaultHeaders);
    let custom = options.headers;
    if (typeof custom === 'string' && custom.trim()) {
      try { custom = JSON.parse(custom); } catch (e) { custom = null; }
    }
    if (custom && typeof custom === 'object') {
      for (const [k, v] of Object.entries(custom)) if (v !== null && v !== undefined) headers[k] = String(v);
    }
    const cookie = this.jar.header(url);
    if (cookie) headers.Cookie = cookie;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeout || this.timeout);
    let res;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: method === 'GET' || method === 'HEAD' ? undefined : (options.body === undefined ? undefined : String(options.body)),
        redirect: options.redirect === 'manual' ? 'manual' : 'follow',
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    this.jar.setFromResponse(url, res);
    let buf = Buffer.from(await res.arrayBuffer());
    const enc = (res.headers.get('content-encoding') || '').toLowerCase();
    if (enc.includes('gzip')) { try { buf = zlib.gunzipSync(buf); } catch (e) { /* ignore */ } }
    else if (enc.includes('deflate')) { try { buf = zlib.inflateSync(buf); } catch (e) { /* ignore */ } }
    else if (enc.includes('br')) { try { buf = zlib.brotliDecompressSync(buf); } catch (e) { /* ignore */ } }
    let charset = normalizeCharset(options.charset);
    if (!charset) {
      const ct = res.headers.get('content-type') || '';
      const m = ct.match(/charset\s*=\s*([\w-]+)/i);
      if (m) charset = normalizeCharset(m[1]);
    }
    if (!charset) charset = sniffCharsetFromBuffer(buf);
    let body = decodeBuffer(buf, charset || 'utf-8');
    if (!charset && looksLikeMojibake(body)) body = fixMojibake(body);
    return {
      url: res.url || url,
      status: res.status,
      headers: Object.fromEntries(res.headers.entries()),
      buffer: buf,
      charset: charset || 'utf-8',
      body,
      finalUrl: res.url || url,
      redirected: res.redirected,
    };
  }

  async requestRule(urlRule, options = {}) {
    const { url, options: ruleOptions } = parseUrlRule(urlRule);
    const merged = Object.assign({}, ruleOptions, options);
    let finalUrl = url;
    if (merged.js && !options.skipJs) {
      try {
        const { runJsRule } = require('./jsexec');
        const out = runJsRule(merged.js, { baseUrl: url, url });
        if (typeof out === 'string' && out.trim()) {
          // 支持 java.url=... 形式
          if (/^https?:\/\//i.test(out.trim())) finalUrl = out.trim();
        }
      } catch (e) { /* ignore */ }
    }
    const retry = Number(merged.retry || 0);
    let lastErr;
    for (let attempt = 0; attempt <= retry; attempt++) {
      try {
        return await this.request(finalUrl, merged);
      } catch (e) {
        lastErr = e;
        if (attempt < retry) await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
      }
    }
    throw lastErr;
  }
}

module.exports = { HttpClient, parseUrlRule, CookieJar, decodeBuffer, fixMojibake, normalizeCharset, DEFAULT_UA };
