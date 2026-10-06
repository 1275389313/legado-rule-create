'use strict';
/** URL 相关小工具（独立模块，避免循环依赖） */

function isAbsoluteUrl(u) {
  return /^[a-zA-Z][\w+.-]*:/.test(String(u || ''));
}

/**
 * 补全相对 URL。不编码中文，避免部分站点拒绝百分号编码的查询。
 */
function absUrl(base, url) {
  const u = String(url === undefined || url === null ? '' : url).trim();
  if (!u) return '';
  if (/^[a-zA-Z][\w+.-]*:/.test(u)) return u;
  const b = String(base || '').trim();
  if (!b) return u;
  if (u.startsWith('//')) {
    const proto = b.match(/^([a-zA-Z][\w+.-]*):/);
    return (proto ? proto[1] : 'http') + ':' + u;
  }
  let origin = b;
  try {
    const parsed = new URL(b);
    origin = parsed.origin;
    if (u.startsWith('/')) return origin + u;
    const dir = parsed.pathname.replace(/[^/]*$/, '');
    return origin + dir + u.replace(/^\.\//, '');
  } catch (e) {
    const baseClean = b.replace(/\/+$/, '');
    if (u.startsWith('/')) return baseClean + u;
    return baseClean + '/' + u.replace(/^\.\//, '');
  }
}

function sameHost(a, b) {
  try {
    return new URL(a).host === new URL(b).host;
  } catch (e) {
    return false;
  }
}

function normalizeSiteUrl(input) {
  let s = String(input || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s.replace(/^\/+/, '');
  try {
    const u = new URL(s);
    return u.origin + (u.pathname === '/' ? '' : u.pathname.replace(/\/+$/, ''));
  } catch (e) {
    return s.replace(/\/+$/, '');
  }
}

module.exports = { absUrl, isAbsoluteUrl, sameHost, normalizeSiteUrl };
