'use strict';
/** 诊断站点：首页状态、是否被墙/需要JS、搜索入口线索 */
const { HttpClient } = require('../src/core/http');
const { parseHtml } = require('../src/core/dom');
const { selectAll } = require('../src/core/selector');

async function main() {
  const sites = process.argv.slice(2);
  const http = new HttpClient({ timeout: 15000 });
  for (const s of sites) {
    const url = /^https?:/.test(s) ? s : 'https://' + s;
    try {
      const r = await http.request(url);
      const doc = parseHtml(r.body);
      const title = (selectAll(doc, 'title')[0] || { text: '' }).text.slice(0, 50);
      const forms = selectAll(doc, 'form').map((f) => `${f.attr('method') || 'GET'} ${f.attr('action')} [${selectAll(f, 'input').map((i) => i.attr('name')).filter(Boolean).join(',')}]`);
      const scripts = selectAll(doc, 'script[src]').map((x) => x.attr('src')).filter((x) => /challenge|waf|verify|jsl|ddos/i.test(x));
      const searchLinks = selectAll(doc, 'a[href]').map((a) => a.attr('href')).filter((h) => /search|so\.php|\/s\?/i.test(h)).slice(0, 5);
      console.log(`\n=== ${url}`);
      console.log(`  status=${r.status} len=${r.body.length} charset=${r.charset} title=${title}`);
      console.log(`  forms: ${forms.join(' | ') || '(none)'}`);
      if (scripts.length) console.log(`  WAF/JS scripts: ${scripts.slice(0, 3).join(', ')}`);
      console.log(`  search links: ${searchLinks.join(' , ') || '(none)'}`);
    } catch (e) {
      console.log(`\n=== ${url}\n  FAIL ${e.message}`);
    }
  }
}
main();
