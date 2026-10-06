'use strict';
const { AnalyzeRule } = require('../src/core/rule');
const html = '<html><body><div class="row"><div>x1</div><span>s1</span></div><div class="row"><div>x2</div><span>s2</span></div></body></html>';
const a = new AnalyzeRule({ content: html, baseUrl: 'http://x.com/' });
console.log('stringList ||:', JSON.stringify(a.getStringList('span.0@text||span.1@text')));
console.log('stringList &&:', JSON.stringify(a.getStringList('span.0@text&&span.1@text')));
console.log('stringList single:', JSON.stringify(a.getStringList('span.0@text')));
console.log('stringList range:', JSON.stringify(a.getStringList('tag.div[1:2]@text')));
