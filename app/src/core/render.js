'use strict';
/**
 * 页面渲染兜底（JS 站点支持）。
 *
 * 分层设计：
 *   - core/render.js     纯逻辑：判断是否需要 JS 渲染 + 可注入的渲染器接口
 *   - src/main/main.js   Electron 主进程提供真实渲染器（隐藏窗口加载页面后回传 HTML）
 *   - src/server/index.js 通过 IPC/回调把渲染器传进来，并暴露 /api/capabilities
 *
 * 浏览器模式下没有渲染器，此时 capabilities.jsRender=false，界面会禁用相关开关。
 */

const WAF_SIGNATURES = [
  /cf-browser-verification/i,
  /challenge-platform/i,
  /__cf_chl_/i,
  /cdn-cgi\/challenge/i,
  /Just a moment\.\.\./i,
  /Attention Required!/i,
  /Checking your browser/i,
  /document\.cookie\s*=\s*["']?__jsl_clearance/i,
  /wzws-waf|wzws_cid/i,
  /safedog/i,
  /window\.location\.href\s*=\s*["'][^"']*[\?&](?:url|redirect)=/i,
];

const SPA_SIGNATURES = [
  /<div[^>]+id=["'](app|root|vue-app)["'][^>]*>\s*<\/div>/i,
  /__NUXT__|__NEXT_DATA__|window\.__INITIAL_STATE__/i,
  /<script[^>]*type=["']module["'][^>]*src=/i,
  /data-server-rendered/i,
];

/**
 * 判断一个 HTTP 抓取结果是否“看起来没拿到真内容，需要 JS 渲染”。
 * @returns {{ needed: boolean, reason: string }}
 */
function needsJsRender(html, opts = {}) {
  if (!html || typeof html !== 'string') return { needed: true, reason: '响应为空' };
  const minLength = opts.minLength || 2500;
  const trimmed = html.trim();

  for (const re of WAF_SIGNATURES) {
    if (re.test(html)) return { needed: true, reason: '命中风控/JS 挑战页（WAF）' };
  }
  if (/^<!doctype html[^>]*>\s*<html[^>]*>\s*<head>[\s\S]{0,400}?<\/head>\s*<body>\s*<\/body>/i.test(trimmed)) {
    return { needed: true, reason: '空壳 HTML' };
  }
  for (const re of SPA_SIGNATURES) {
    if (re.test(html) && trimmed.length < (opts.spaMaxLength || 20000)) {
      return { needed: true, reason: '疑似前端框架（SPA）空壳页面' };
    }
  }
  // 正文里几乎没有中文/文字内容，多半是脚本渲染
  const text = trimmed.replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, '');
  const links = (html.match(/<a\s[^>]*href=/gi) || []).length;

  if (trimmed.length >= minLength) {
    if (text.length < 200) return { needed: true, reason: '可读文本极少，内容可能由脚本渲染' };
    return { needed: false, reason: '' };
  }
  // 短页面：若已经有可读文本且带若干链接，很可能就是个列表页，不必渲染
  const minText = opts.minText || 50;
  if (text.length >= minText && links >= 5) return { needed: false, reason: '' };
  if (text.length >= minText && links >= 1 && trimmed.length > 1200) return { needed: false, reason: '' };
  return { needed: true, reason: `内容偏少（${trimmed.length} 字节 / ${text.length} 字文本 / ${links} 个链接）` };
}

/**
 * 渲染器：把一个 HTTP 抓取函数包装成“自动在需要时回退到 JS 渲染”的抓取器。
 * @param {object} opts
 *   opts.http        HttpClient 实例
 *   opts.renderer    形如 { render(url, options) -> {body, finalUrl, status} }，可为 null
 *   opts.enabled     是否启用渲染兜底
 */
function createSmartFetcher(opts = {}) {
  const http = opts.http;
  const renderer = opts.renderer || null;
  const enabled = !!opts.enabled && !!renderer;

  return {
    /** 普通抓取，保持与 HttpClient.request 一致 */
    request(url, options) {
      return http.request(url, options);
    },

    /**
     * 先普通抓取；必要时（且渲染器可用）换成渲染结果。
     * @returns {Promise<{res: object, rendered: boolean, reason: string}>}
     */
    async fetchMaybeRendered(url, options = {}) {
      const res = await http.request(url, options);
      if (!enabled || options.noRender) return { res, rendered: false, reason: '' };
      const verdict = needsJsRender(res.body, options.renderOptions);
      if (!verdict.needed) return { res, rendered: false, reason: '' };
      if (opts.log) opts.log(`[render] ${verdict.reason}，改用 JS 渲染 ${url}`);
      try {
        const out = await renderer.render(url, {
          waitMs: options.waitMs || 1200,
          timeout: options.timeout || 20000,
        });
        if (out && typeof out.body === 'string' && out.body.length > res.body.length) {
          return {
            res: Object.assign({}, res, {
              body: out.body,
              finalUrl: out.finalUrl || res.finalUrl,
              rendered: true,
            }),
            rendered: true,
            reason: verdict.reason,
          };
        }
        return { res, rendered: false, reason: verdict.reason + '（渲染结果没更好）' };
      } catch (e) {
        if (opts.log) opts.log(`[render] 渲染失败：${e.message}`);
        return { res, rendered: false, reason: verdict.reason + '（渲染失败）' };
      }
    },
  };
}

module.exports = { needsJsRender, createSmartFetcher, WAF_SIGNATURES, SPA_SIGNATURES };
