'use strict';
const { runJsRule } = require('../src/core/jsexec');

const cases = [
  ['bookUrl(try+if)', 'let href = String(result)\ntry{\nif(!href.match(/www/)){ "/book/" + href.match(/\\/\\/(.*)\\.janpn/)[1] + ".html" }\n}catch(e){href}',
    '//a.janpn.com/x.html', '"/book/a.html"'],
  ['bookUrl(含www)', 'let href = String(result)\ntry{\nif(!href.match(/www/)){ "/book/" + href.match(/\\/\\/(.*)\\.janpn/)[1] + ".html" }\n}catch(e){href}',
    '//www.janpn.com/x.html', 'undefined（if 条件不成立且 catch 未被触发）'],
  ['kind(if/else+循环)', 'let tag = []\nfor(let i in result){tag.push(String(result[i]))}\nif(!tag[0].startsWith("《")){\n tag[0]=tag[0].replace(/小说.*/,"")\n tag\n}else{\n tag[1].replace(/更新时间：/,"")\n}',
    ['玄幻奇幻小说：《斗破苍穹》', '更新时间：2019'], '数组或字符串'],
  ['简单表达式', 'String(result).toUpperCase()', 'abc', '"ABC"'],
  ['单语句块', 'let x = String(result)\nx + "!"', 'abc', '"abc!"'],
];

for (const [note, code, input, expect] of cases) {
  let out;
  try { out = JSON.stringify(runJsRule(code, { result: input })); } catch (e) { out = 'ERROR ' + e.message; }
  console.log(`${note.padEnd(22)} => ${String(out).slice(0, 90).padEnd(92)} // 期望 ${expect}`);
}
