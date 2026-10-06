'use strict';
const { AnalyzeRule } = require('../src/core/rule');
const html = '<html><body><div class="row"><div>x1</div><span>s1</span></div><div class="row"><div>x2</div><span>s2</span></div></body></html>';
const a = new AnalyzeRule({ content: html, baseUrl: 'http://x.com/' });
const cases = [
  ['class.row.-1', 'expect 1'],
  ['class.row.-1@tag.div!0', 'expect 0 (row 内第一个 div 被排除)'],
  ['class.row.0@tag.div.0@text', 'expect x1'],
  ['span@text', 'expect s1'],
  ['span.0@text', 'expect s1'],
  ['span.-1@text', 'expect s2'],
  ['@css:.row > div', 'expect x1'],
  ['tag.div[1:2]@text', 'expect 2 个'],
  ['tag.div[!0]@text', 'expect 排除第一个'],
  ['text.x1', 'expect 匹配文本节点'],
  ['span.0@text&&span.1@text', 'expect s1s2'],
  ['span.0@text||span.1@text', 'expect s1'],
  ['span@text##s', 'expect 去掉 s'],
  ['children@text', 'expect 根的孩子文本'],
];
for (const [rule, note] of cases) {
  let out;
  try {
    const els = a.getElements(rule);
    const vals = els.map((e) => (typeof e === 'string' ? e : (e.text !== undefined ? e.text : JSON.stringify(e))));
    out = JSON.stringify(vals) + ' | string=' + JSON.stringify(a.getString(rule));
  } catch (e) { out = 'ERROR ' + e.message; }
  console.log(rule.padEnd(30), '=>', out, '   //', note);
}
