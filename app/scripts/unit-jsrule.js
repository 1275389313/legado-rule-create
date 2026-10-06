'use strict';
/** @js: 规则执行测试 */
const { AnalyzeRule } = require('../src/core/rule');

const HTML = `<div class="list">
  <a href="//www.example.com/book/1.html">书一</a>
  <a href="/book/2.html">书二</a>
</div>
<h3>《斗破苍穹》</h3>
<div id="htmlContent"><p>正文第一段</p><p>正文第二段</p></div>
<ul class="panel-chapterlist"><li><a href="/c/1.html">第一章</a></li><li><a href="/c/2.html">第二章</a></li></ul>`;

// 单条 href 的 fixture，用于验证 href@js: 链路
const ONE_LINK = '<a href="//www.janpn.com/book/x.html">x</a>';

const cases = [
  // 真实书源写法：href 拿到属性值后由 js 处理；测试页 URL 不含 www，条件不成立 → 走 catch 原样返回
  ['href@js:\nlet href = String(result)\ntry{\nif(!href.match(/www/)){ "/book/" + href.match(/\\/\\/(.*)\\.janpn/)[1] + ".html" }\n}catch(e){href}', 'js 处理 bookUrl', ONE_LINK, '原样或改写后的 href'],
  ['@js: result.toUpperCase()', '整段 js（上下文文本）', HTML, '含《斗破苍穹》大写'],
  ['h3@text##《|》', '正则净化去书名号', HTML, '"斗破苍穹"'],
  ['h3@text', '普通取文本', HTML, '"《斗破苍穹》"'],
  ['id.htmlContent@html', '取正文 HTML', HTML, '含 <p> 标签'],
  ['ul.panel-chapterlist a@text', '目录链接文本', HTML, '["第一章","第二章"]'],
  ['href@js:String(result).replace("/book/","/read/")', 'js 链式替换', ONE_LINK, '含 /read/'],
  ['<js>result.split("").reverse().join("")</js>', '整段 <js> 块', HTML, '倒序文本'],
];

for (const [rule, note, fixture, expect] of cases) {
  const a = new AnalyzeRule({ content: fixture || HTML, baseUrl: 'http://www.example.com/' });
  let out;
  try {
    out = JSON.stringify(a.getStringList(rule)).slice(0, 120);
  } catch (e) { out = 'ERROR ' + e.message; }
  console.log(`${note.padEnd(18)} => ${out}   // 期望 ${expect}`);
}

