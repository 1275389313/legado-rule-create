'use strict';
/** 找出某些站点的真实搜索入口（人工核对用） */
const { HttpClient } = require('../src/core/http');
const { parseHtml } = require('../src/core/dom');
const { selectAll } = require('../src/core/selector');

async function main() {
  const sites = process.argv.slice(2);
  const http = new HttpClient({ timeout: 15000 });
  for (const site of sites) {
    const base = site.replace(/\/+$/, '');
    console.log('\n=== ' + base);
    try {
      const r = await http.request(base);
      const doc = parseHtml(r.body);
      console.log('  home', r.status, r.body.length, (selectAll(doc, 'title')[0] || { text: '' }).text.slice(0, 40));
      const forms = selectAll(doc, 'form');
      for (const f of forms) {
        console.log('  form:', f.attr('method') || 'GET', f.attr('action'),
          JSON.stringify(selectAll(f, 'input').map((i) => [i.attr('name'), i.attr('type')].filter(Boolean).join(':'))));
      }
      const scripts = selectAll(doc, 'script').map((s) => s.text).join('\n');
      const hits = [...scripts.matchAll(/["']((?:https?:)?\/\/[^"']*?(?:search|s\.php)[^"']*)["']/gi)].map((m) => m[1]);
      const rel = [...scripts.matchAll(/["'](\/[^"']*?(?:search|s\.php)[^"']*)["']/gi)].map((m) => m[1]);
      console.log('  script urls:', [...new Set([...hits, ...rel])].slice(0, 6).join(' , ') || '(none)');
      // 直接试几个路径
      for (const path of ['/s.php', '/search.php', '/search/', '/s/', '/index.php?s=search']) {
        const rr = await http.request(base + path).catch(() => null);
        if (rr) console.log(`  probe ${path}: ${rr.status} len=${rr.body.length}`);
      }
    } catch (e) {
      console.log('  FAIL', e.message);
    }
  }
}
main();
