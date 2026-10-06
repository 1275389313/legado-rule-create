'use strict';
/**
 * 批量测试自动生成：对多个站点跑一遍，输出得分汇总。
 * 用法: node scripts/gen-batch.js [关键字]
 */

const { SourceGenerator } = require('../src/core/generator');

const SITES = [
  'http://www.hunhun.cc',
  'https://www.biquge365.net',
  'https://www.bqg128.com',
  'https://www.bige3.cc',
  'https://www.69shuba.com',
  'https://www.ibiquges.info',
  'http://www.xbiquge.la',
  'https://www.bqgui.cc',
  'https://www.22biqu.com',
  'https://www.biquge5200.cc',
  'https://www.qbtr.cc',
  'https://www.shuquge.com',
  'https://www.ptwxz.com',
  'https://www.ddxs.com',
  'https://www.37zw.net',
];

async function main() {
  const key = process.argv[2] || '斗破苍穹';
  const rows = [];
  for (const site of SITES) {
    const gen = new SourceGenerator({ testKey: key });
    const t0 = Date.now();
    let r;
    try {
      r = await gen.generate(site, { testKey: key });
    } catch (e) {
      rows.push({ site, ok: false, score: 0, err: e.message });
      console.log(`${site.padEnd(32)} EXCEPTION ${e.message}`);
      continue;
    }
    const v = r.validation;
    const row = {
      site,
      name: r.name,
      searchUrl: r.source && r.source.searchUrl,
      score: v ? v.score : 0,
      ok: r.ok,
      counts: v ? {
        search: v.steps.search && v.steps.search.count,
        toc: v.steps.toc && v.steps.toc.count,
        content: v.steps.content && v.steps.content.length,
      } : null,
      issues: v ? v.issues : r.notes,
      sec: ((Date.now() - t0) / 1000).toFixed(1),
    };
    rows.push(row);
    console.log(`${site.padEnd(32)} score=${String(row.score).padStart(3)} search=${String(row.counts && row.counts.search).padStart(3)} toc=${String(row.counts && row.counts.toc).padStart(4)} content=${String(row.counts && row.counts.content).padStart(5)} ${row.sec}s ${row.ok ? 'OK' : ''}`);
    if (!row.ok) console.log('    issues:', (row.issues || []).slice(0, 2).join(' | '));
  }
  const okCount = rows.filter((r) => r.ok).length;
  const avg = rows.reduce((a, b) => a + b.score, 0) / rows.length;
  console.log(`\n成功 ${okCount}/${rows.length}，平均分 ${avg.toFixed(0)}`);
  require('fs').writeFileSync('scripts/out-batch.json', JSON.stringify(rows, null, 2));
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
