'use strict';
/**
 * 服务端 API 冒烟测试。
 * 建议用独立数据目录运行，避免污染真实书源库：
 *   STUDIO_DATA_DIR=.tmp-apitest PORT=8399 node src/server/index.js
 *   BASE=http://127.0.0.1:8399 node scripts/api-test.js
 */
const BASE = process.env.BASE || 'http://127.0.0.1:8317';

async function j(path, options) {
  const res = await fetch(BASE + path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, options));
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch (e) { data = text; }
  return { status: res.status, data };
}

async function main() {
  console.log('1) health:', JSON.stringify((await j('/api/health')).data));

  const sample = await j('/api/sample');
  console.log('2) sample:', sample.status, sample.data.count, sample.data.fileName);

  const imp = await j('/api/library/import', {
    method: 'POST',
    body: JSON.stringify({ sources: sample.data.sources, fileName: sample.data.fileName }),
  });
  console.log('3) import:', imp.status, JSON.stringify(imp.data.stats), 'total=', imp.data.total);

  const lib = await j('/api/library?keyword=' + encodeURIComponent('混混'));
  console.log('4) search library 混混:', lib.data.sources.length, 'stats:', JSON.stringify(lib.data.stats));

  const src = lib.data.sources[0];
  const save = await j('/api/library/source', { method: 'POST', body: JSON.stringify({ source: { ...src, bookSourceComment: 'API 测试' } }) });
  console.log('5) upsert:', save.status, save.data.source.bookSourceComment);

  const gen = await j('/api/generate', { method: 'POST', body: JSON.stringify({ url: 'http://www.hunhun.cc', testKey: '斗破苍穹' }) });
  console.log('6) generate:', gen.status, 'ok=', gen.data.ok, 'score=', gen.data.validation && gen.data.validation.score);

  const val = await j('/api/validate', { method: 'POST', body: JSON.stringify({ source: src, key: '斗破苍穹' }) });
  console.log('7) validate 混混:', val.data.score, 'steps=', Object.keys(val.data.steps).map((k) => k + ':' + val.data.steps[k].ok).join(' '));

  const search = await j('/api/preview/search', { method: 'POST', body: JSON.stringify({ source: src, key: '斗破苍穹' }) });
  console.log('8) preview search:', search.data.count, search.data.books[0] && search.data.books[0].name);

  const evalRes = await j('/api/eval', { method: 'POST', body: JSON.stringify({ url: 'http://www.hunhun.cc', rules: ['title@text', 'a.0@href'] }) });
  console.log('9) eval:', evalRes.status, JSON.stringify(evalRes.data.results).slice(0, 200));

  const exp = await j('/api/library/export?urls=' + encodeURIComponent(src.bookSourceUrl));
  console.log('10) export:', exp.status, Array.isArray(exp.data) ? exp.data.length : exp.data);

  const del = await j('/api/library/source?url=' + encodeURIComponent(src.bookSourceUrl), { method: 'DELETE' });
  console.log('11) delete:', del.status, del.data.ok);
  const after = await j('/api/library/stats');
  console.log('12) stats after delete:', JSON.stringify(after.data.count));
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
