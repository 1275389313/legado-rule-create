'use strict';
/**
 * 真实书源批量回归：从 折黎No.0051.json 里抽样，用内置引擎跑完整链路，
 * 统计搜索/详情/目录/正文各环节的通过率，作为引擎兼容性的量化依据。
 *
 * 用法：
 *   node scripts/test-sources.js [抽样数量] [并发数] [测试关键字]
 *   node scripts/test-sources.js 30 4 斗破苍穹
 */

const fs = require('fs');
const path = require('path');
const { SourceSession } = require('../src/core/session');

const ROOT = path.resolve(__dirname, '..', '..');
const SAMPLE = process.env.SAMPLE_FILE || path.join(ROOT, '折黎No.0051.json');

function pickSample(all, n) {
  // 优先挑“静态 HTML + 有搜索规则”的书源，网络请求更少更快
  const html = all.filter((s) => s.searchUrl && s.ruleSearch && s.ruleSearch.bookList
    && !/@js:|<js>/.test(String(s.searchUrl) + String(s.ruleSearch.bookList)));
  const shuffled = html.slice().sort(() => Math.random() - 0.5);
  return shuffled.slice(0, n);
}

async function runOne(source, key) {
  const session = new SourceSession(source, { timeout: 15000 });
  const out = { name: source.bookSourceName, url: source.bookSourceUrl, steps: {}, score: 0 };
  try {
    const search = await session.search(key, 1);
    out.steps.search = { ok: search.ok, count: search.books.length, err: search.errors[0] };
    if (!search.ok) return out;
    const book = search.books[0];
    const info = await session.bookInfo(book);
    out.steps.bookInfo = { ok: info.ok, err: info.errors[0] };
    const merged = Object.assign({}, book, info.info || {});
    const toc = await session.toc(merged, info.html);
    out.steps.toc = { ok: toc.ok, count: toc.chapters.length, err: toc.errors[0] };
    if (toc.ok && toc.chapters.length) {
      const content = await session.content(merged, toc.chapters[Math.min(1, toc.chapters.length - 1)], { maxPages: 1 });
      out.steps.content = { ok: content.ok, length: content.length, err: content.errors[0] };
    } else {
      out.steps.content = { ok: false, err: '目录为空' };
    }
    let score = 0;
    if (out.steps.search.ok) score += 25;
    if (out.steps.bookInfo.ok) score += 15;
    if (out.steps.toc.ok) score += 25;
    if (out.steps.content.ok) score += 35;
    out.score = score;
  } catch (e) {
    out.error = e.message;
  }
  return out;
}

async function runPool(items, worker, concurrency, onDone) {
  const results = [];
  let idx = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (idx < items.length) {
      const my = idx++;
      const r = await worker(items[my], my);
      results[my] = r;
      if (onDone) onDone(r, my);
    }
  });
  await Promise.all(runners);
  return results;
}

async function main() {
  const n = Number(process.argv[2] || 20);
  const concurrency = Number(process.argv[3] || 4);
  const key = process.argv[4] || '斗破苍穹';
  const all = JSON.parse(fs.readFileSync(SAMPLE, 'utf8'));
  const sample = pickSample(all, n);
  console.log(`样本书源总数 ${all.length}，本次抽取 ${sample.length} 个，并发 ${concurrency}，关键字「${key}」\n`);

  const t0 = Date.now();
  const results = await runPool(sample, (s) => runOne(s, key), concurrency, (r, i) => {
    const st = r.steps || {};
    const flag = (x) => (x ? '✓' : '✗');
    console.log(`${String(i + 1).padStart(3)}. ${String(r.score).padStart(3)}分 搜${flag(st.search && st.search.ok)} 详${flag(st.bookInfo && st.bookInfo.ok)} 目${flag(st.toc && st.toc.ok)} 文${flag(st.content && st.content.ok)}  ${(r.name || '').slice(0, 22)}  ${st.search && st.search.ok ? `(${st.search.count}本/${st.toc ? st.toc.count : 0}章/${st.content ? st.content.length : 0}字)` : (st.search && st.search.err || r.error || '')}`);
  });

  const stat = (f) => results.filter((r) => f(r)).length;
  const pct = (x) => `${((x / results.length) * 100).toFixed(0)}%`;
  console.log('\n===== 汇总 =====');
  console.log(`搜索成功   ${stat((r) => r.steps && r.steps.search && r.steps.search.ok)}/${results.length}  ${pct(stat((r) => r.steps && r.steps.search && r.steps.search.ok))}`);
  console.log(`详情成功   ${stat((r) => r.steps && r.steps.bookInfo && r.steps.bookInfo.ok)}/${results.length}  ${pct(stat((r) => r.steps && r.steps.bookInfo && r.steps.bookInfo.ok))}`);
  console.log(`目录成功   ${stat((r) => r.steps && r.steps.toc && r.steps.toc.ok)}/${results.length}  ${pct(stat((r) => r.steps && r.steps.toc && r.steps.toc.ok))}`);
  console.log(`正文成功   ${stat((r) => r.steps && r.steps.content && r.steps.content.ok)}/${results.length}  ${pct(stat((r) => r.steps && r.steps.content && r.steps.content.ok))}`);
  console.log(`全流程通过 ${stat((r) => r.score === 100)}/${results.length}  ${pct(stat((r) => r.score === 100))}`);
  console.log(`平均得分   ${(results.reduce((a, b) => a + (b.score || 0), 0) / results.length).toFixed(1)}`);
  console.log(`耗时       ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  fs.writeFileSync(path.join(__dirname, 'out-sources-test.json'), JSON.stringify(results, null, 2));
  console.log('\n明细已写入 app/scripts/out-sources-test.json');
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
