'use strict';
const { parseHtml } = require('../src/core/dom');
const cases = [
  '<div>x</div>',
  '<html><body><div class="row">x</div></body></html>',
  '<div class="row"><div>x1</div></div>',
  '<a href="/x">y</a>',
];
for (const c of cases) {
  process.stdout.write('case=' + JSON.stringify(c) + ' ... ');
  const doc = parseHtml(c);
  console.log('ok children=' + doc.root.children.length);
}
