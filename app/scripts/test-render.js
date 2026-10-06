'use strict';
/**
 * JS 渲染兜底链路测试（不需要浏览器）。
 *
 * 起一个本地站点，模拟三种情况：
 *   /            空壳 SPA 首页（<div id="app"></div> + 脚本）
 *   /full        渲染后才有的"真实"首页（含搜索表单与推荐列表）
 *   /search?q=   渲染后才有的搜索结果页（含书籍列表）
 *   /book/1/     详情页（含目录）
 * 然后：
 *   1) 用一个 stub 渲染器（返回 /full）驱动 SourceGenerator，验证能识别空壳并回退
 *   2) SourceSession 在纯 HTTP 下抓空壳 → 拿到空内容；带渲染器时 → 拿到正文
 * 以此证明 "需要 JS 的站点" 这条链路是通的。
 */

const http = require('http');
const { SourceGenerator } = require('../src/core/generator');
const { SourceSession } = require('../src/core/session');
const { needsJsRender } = require('../src/core/render');

const SHELL = `<!DOCTYPE html><html><head><title>JS 站点</title></head>
<body><div id="app"></div>
<script>document.getElementById('app').innerHTML = '<p>loading</p>';</script>
</body></html>`;

const FULL_HOME = `<!DOCTYPE html><html><head><title>JS 小说站_免费阅读</title></head>
<body>
<form action="/search" method="get"><input type="text" name="q"><button>搜索</button></form>
<div class="booklist">
  <div class="book-item"><a href="/book/1/"><img src="/cover/1.jpg" alt="斗破苍穹"></a>
    <h3><a href="/book/1/">斗破苍穹</a></h3><p class="author">作者：天蚕土豆</p></div>
  <div class="book-item"><a href="/book/2/"><img src="/cover/2.jpg" alt="斗罗大陆"></a>
    <h3><a href="/book/2/">斗罗大陆</a></h3><p class="author">作者：唐家三少</p></div>
  <div class="book-item"><a href="/book/3/"><img src="/cover/3.jpg" alt="凡人修仙传"></a>
    <h3><a href="/book/3/">凡人修仙传</a></h3><p class="author">作者：忘语</p></div>
</div></body></html>`;

const FULL_SEARCH = `<!DOCTYPE html><html><head><title>搜索结果</title></head><body>
<div id="result">
  <div class="book-item"><a href="/book/1/"><img src="/cover/1.jpg" alt="斗破苍穹"></a>
    <h3><a href="/book/1/">斗破苍穹</a></h3><p class="author">作者：天蚕土豆</p></div>
  <div class="book-item"><a href="/book/2/"><img src="/cover/2.jpg" alt="斗罗大陆"></a>
    <h3><a href="/book/2/">斗罗大陆</a></h3><p class="author">作者：唐家三少</p></div>
  <div class="book-item"><a href="/book/3/"><img src="/cover/3.jpg" alt="凡人修仙传"></a>
    <h3><a href="/book/3/">凡人修仙传</a></h3><p class="author">作者：忘语</p></div>
</div></body></html>`;

const FULL_BOOK = `<!DOCTYPE html><html><head><title>斗破苍穹</title>
<meta property="og:novel:book_name" content="斗破苍穹">
<meta property="og:novel:author" content="天蚕土豆">
<meta property="og:novel:category" content="玄幻小说">
<meta property="og:image" content="/cover/1.jpg">
</head><body>
<h1>斗破苍穹</h1>
<div id="intro">这里是简介内容，讲述少年萧炎的成长故事。</div>
<div class="chapterlist"><ul>
  <li><a href="/book/1/1.html">第一章 陨落的天才</a></li>
  <li><a href="/book/1/2.html">第二章 斗气大陆</a></li>
  <li><a href="/book/1/3.html">第三章 客人</a></li>
  <li><a href="/book/1/4.html">第四章 云岚宗</a></li>
  <li><a href="/book/1/5.html">第五章 药老</a></li>
</ul></div></body></html>`;

const FULL_CHAPTER = `<!DOCTYPE html><html><head><title>第一章 陨落的天才</title></head><body>
<h1>第一章 陨落的天才</h1>
<div id="content">
${'<p>斗之气，三段！望着测验魔石碑上面闪亮得甚至有些刺眼的五个大字，少年面无表情，唇角有着一抹自嘲。</p>'.repeat(6)}
</div>
<a href="/book/1/2.html">下一章</a>
</body></html>`;

function startSite() {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const send = (html) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    };
    // 纯 HTTP 访问只会拿到空壳；带 ?render=1 才返回"渲染后"的内容
    const rendered = u.searchParams.get('render') === '1' || req.headers['x-studio-rendered'] === '1';
    if (u.pathname === '/') return send(rendered ? FULL_HOME : SHELL);
    if (u.pathname === '/search') return send(rendered ? FULL_SEARCH : SHELL);
    if (u.pathname === '/book/1/') return send(FULL_BOOK);
    if (u.pathname === '/book/1/1.html') return send(FULL_CHAPTER);
    res.writeHead(404); res.end('not found');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/** stub 渲染器：把 ?render=1 附加到 url 上再抓一次，模拟浏览器执行脚本后的结果 */
function stubRenderer() {
  const { HttpClient } = require('../src/core/http');
  const client = new HttpClient({ timeout: 8000 });
  const calls = [];
  return {
    calls,
    async render(url, options = {}) {
      calls.push(url);
      const u = new URL(url);
      u.searchParams.set('render', '1');
      const r = await client.request(u.href);
      return { body: r.body, finalUrl: u.href, status: 200 };
    },
  };
}

async function main() {
  const { server, port } = await startSite();
  const base = `http://127.0.0.1:${port}`;
  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok, detail });
    console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
  };

  try {
    // 1) 判定逻辑
    const v1 = needsJsRender(SHELL);
    check('空壳 SPA 被识别为需要渲染', v1.needed, v1.reason);
    const v2 = needsJsRender(FULL_HOME);
    check('有内容有链接的列表页不需要渲染', !v2.needed, v2.reason || `文本/链接足够（${FULL_HOME.length} 字节）`);
    const v3 = needsJsRender('<html><body>Just a moment...</body></html>');
    check('WAF 挑战页被识别', v3.needed, v3.reason);

    // 2) 纯 HTTP 会话：拿到的是空壳，搜索不到书
    const srcPlain = { bookSourceName: 'js站', bookSourceUrl: base, searchUrl: '/search?q={{key}}&page={{page}}', ruleSearch: { bookList: '@css:div.book-item', name: 'h3 a@text', bookUrl: 'a@href', author: '.author@text' } };
    const plainSession = new SourceSession(srcPlain, { timeout: 8000 });
    const plainSearch = await plainSession.search('斗破');
    check('纯 HTTP 抓不到 JS 站点的书（符合预期）', plainSearch.books.length === 0, `books=${plainSearch.books.length}`);

    // 3) 带渲染器的会话：能拿到书
    const renderer = stubRenderer();
    const smartSession = new SourceSession(srcPlain, { timeout: 8000, renderer });
    const smartSearch = await smartSession.search('斗破');
    check('带渲染兜底后抓到了书', smartSearch.books.length === 3,
      smartSearch.books.map((b) => b.name).join(', '));
    check('渲染器确实被调用', renderer.calls.length > 0, renderer.calls.slice(0, 2).join(' , '));
    check('作者字段解析正确（含"作者："前缀）', smartSearch.books[0] && smartSearch.books[0].author === '作者：天蚕土豆',
      smartSearch.books[0] && smartSearch.books[0].author);

    // 4) 自动造源：用 stub 渲染器驱动完整流程
    const genRenderer = stubRenderer();
    const gen = new SourceGenerator({ renderer: genRenderer, testKey: '斗破', timeout: 8000, log: () => {} });
    const result = await gen.generate(base, { testKey: '斗破' });
    check('自动造源成功（搜索入口靠渲染后才出现）', !!result.source.searchUrl, result.source.searchUrl);
    check('自动造源识别出书籍列表', !!(result.source.ruleSearch && result.source.ruleSearch.bookList),
      JSON.stringify(result.source.ruleSearch && result.source.ruleSearch.bookList));
    check('自动造源探测到章节列表', !!(result.source.ruleToc && result.source.ruleToc.chapterList),
      JSON.stringify(result.source.ruleToc && result.source.ruleToc.chapterList));
    check('自动造源探测到正文规则', !!(result.source.ruleContent && result.source.ruleContent.content),
      JSON.stringify(result.source.ruleContent && result.source.ruleContent.content));
    check('渲染统计已记录', result.renderStats && result.renderStats.attempted > 0,
      JSON.stringify(result.renderStats));

    // 5) 关闭渲染开关时应退回纯 HTTP（抓不到书）
    const genNoRender = new SourceGenerator({ renderer: stubRenderer(), useRender: false, timeout: 8000, log: () => {} });
    const r2 = await genNoRender.generate(base, { testKey: '斗破' });
    check('关闭渲染开关后不启用兜底', !(r2.source && r2.source.searchUrl), (r2.notes || []).join(' | '));
  } finally {
    server.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n通过 ${results.length - failed.length}/${results.length}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
