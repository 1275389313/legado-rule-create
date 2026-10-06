'use strict';
/**
 * 端到端验收测试：模拟一个真实用户的完整使用流程。
 *   启动（空书源库）→ 自动导入样本书源 → 网址造源 → 保存 → 校验 → 导出 → 删除
 * 用法： BASE=http://127.0.0.1:8444 node scripts/acceptance.js
 */

const BASE = process.env.BASE || 'http://127.0.0.1:8444';
const SITE = process.env.SITE || 'http://www.hunhun.cc';
const KEY = process.env.KEY || '斗破苍穹';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '  — ' + detail : ''}`);
}

async function j(path, options) {
  const res = await fetch(BASE + path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, options));
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch (e) { data = text; }
  return { status: res.status, data };
}

async function main() {
  console.log(`验收目标: ${BASE}\n`);

  // 1. 服务与能力
  const h = await j('/api/health');
  check('1. 服务健康检查', h.status === 200 && h.data.ok, `v${h.data.version}`);
  const caps = await j('/api/capabilities');
  check('2. 能力探测接口', caps.status === 200 && typeof caps.data.jsRender === 'boolean',
    `jsRender=${caps.data.jsRender}, mode=${caps.data.mode}`);

  // 2. 界面资源
  for (const [name, path, min] of [['首页', '/', 5000], ['样式', '/css/app.css', 5000], ['脚本', '/js/app.js', 20000]]) {
    const r = await fetch(BASE + path);
    const body = await r.text();
    check(`3. 静态资源 ${name}`, r.status === 200 && body.length > min, `${body.length} 字节`);
  }

  // 3. 自动导入样本书源
  const stats0 = await j('/api/library/stats');
  check('4. 首次启动自动导入样本书源', stats0.data.count === 504, `${stats0.data.count} 个书源`);

  // 4. 重复导入应去重
  const sample = await j('/api/sample');
  const imp = await j('/api/library/import', {
    method: 'POST',
    body: JSON.stringify({ sources: sample.data.sources, fileName: sample.data.fileName }),
  });
  check('5. 重复导入正确去重', imp.data.stats.added === 0 && imp.data.total === 504,
    `新增 ${imp.data.stats.added} / 更新 ${imp.data.stats.updated} / 总数 ${imp.data.total}`);

  // 5. 网址造源
  const gen = await j('/api/generate', { method: 'POST', body: JSON.stringify({ url: SITE, testKey: KEY }) });
  const g = gen.data;
  check('6. 网址自动造源成功', gen.status === 200 && !!g.source && !!g.source.searchUrl, g.source && g.source.searchUrl);
  check('7. 造源自测满分', g.validation && g.validation.score === 100, `得分 ${g.validation && g.validation.score}`);
  check('8. 生成的规则齐全', !!(g.source.ruleSearch.bookList && g.source.ruleToc.chapterList && g.source.ruleContent.content),
    `bookList=${g.source.ruleSearch.bookList}`);

  // 6. 保存到书源库（该网址已存在，走覆盖；这里验证覆盖不会报错且规则是最新的）
  const find = await j('/api/library/find?url=' + encodeURIComponent(g.source.bookSourceUrl));
  check('9. 保存前能查到同网址已有书源', find.data.exists, find.data.source && find.data.source.bookSourceName);
  const save = await j('/api/library/source', { method: 'POST', body: JSON.stringify({ source: g.source }) });
  check('10. 保存（覆盖同网址书源）', save.status === 200 && !!save.data.source, save.data.source.bookSourceName);
  const after = await j('/api/library/find?url=' + encodeURIComponent(g.source.bookSourceUrl));
  check('11. 覆盖后规则已更新', after.data.exists
    && (await j('/api/library?keyword=' + encodeURIComponent('混混'))).data.sources[0].ruleSearch.bookList === g.source.ruleSearch.bookList,
    after.data.source.bookSourceName);

  // 7. 用一个新网址保存，应新增
  const newUrl = g.source.bookSourceUrl + '/acceptance-' + Date.now();
  const copy = Object.assign({}, g.source, { bookSourceUrl: newUrl, bookSourceName: '验收测试源' });
  const saved2 = await j('/api/library/source', { method: 'POST', body: JSON.stringify({ source: copy }) });
  const stats1 = await j('/api/library/stats');
  check('12. 用新网址保存会新增', saved2.status === 200 && stats1.data.count === 505, `${stats1.data.count} 个`);

  // 8. 编辑后校验
  const edited = Object.assign({}, copy, { bookSourceComment: '验收测试' });
  const val = await j('/api/validate', { method: 'POST', body: JSON.stringify({ source: edited, key: KEY }) });
  check('13. 真机校验全流程通过', val.data.score === 100,
    `得分 ${val.data.score}, 搜索 ${val.data.steps.search.count} 本, 目录 ${val.data.steps.toc.count} 章, 正文 ${val.data.steps.content.length} 字`);

  // 9. 分步预览
  const ps = await j('/api/preview/search', { method: 'POST', body: JSON.stringify({ source: edited, key: KEY }) });
  check('14. 搜索预览', ps.data.count > 0, `${ps.data.count} 本, 第一本「${ps.data.books[0] && ps.data.books[0].name}」`);
  const bookUrl = ps.data.books[0].bookUrl;
  const pi = await j('/api/preview/bookInfo', { method: 'POST', body: JSON.stringify({ source: edited, bookUrl }) });
  check('15. 详情预览', pi.data.ok, `${pi.data.info.name} / ${pi.data.info.author}`);
  const pt = await j('/api/preview/toc', { method: 'POST', body: JSON.stringify({ source: edited, bookUrl }) });
  check('16. 目录预览', pt.data.ok && pt.data.count > 0, `${pt.data.count} 章`);
  const pc = await j('/api/preview/content', { method: 'POST', body: JSON.stringify({ source: edited, chapterUrl: pt.data.chapters[0].url }) });
  check('17. 正文预览', pc.data.ok && pc.data.length > 500, `${pc.data.length} 字`);

  // 10. 规则调试
  const ev = await j('/api/eval', { method: 'POST', body: JSON.stringify({ url: SITE, rules: ['title@text', 'a.0@href'] }) });
  check('18. 规则调试求值', ev.status === 200 && !!ev.data.results['title@text'], JSON.stringify(ev.data.results['title@text'].values).slice(0, 60));

  // 11. 导出
  const exp = await j('/api/library/export?urls=' + encodeURIComponent(newUrl));
  check('19. 导出单个书源', exp.status === 200 && exp.data.length === 1, `${exp.data.length} 个`);
  const expAll = await j('/api/library/export');
  check('20. 导出全部书源', expAll.status === 200 && expAll.data.length === 505, `${expAll.data.length} 个`);
  const valid = expAll.data.every((s) => s.bookSourceUrl && s.bookSourceName);
  const dup = new Set(expAll.data.map((s) => s.bookSourceUrl)).size !== expAll.data.length;
  check('21. 导出内容结构完整且无重复', valid && !dup, '每条都有 url 与 name，URL 无重复');

  // 12. 清理
  const del = await j('/api/library/source?url=' + encodeURIComponent(newUrl), { method: 'DELETE' });
  const stats2 = await j('/api/library/stats');
  check('22. 删除书源', del.data.ok && stats2.data.count === 504, `${stats2.data.count} 个`);

  // 13. 分组
  const groups = await j('/api/library/groups');
  check('23. 分组统计', groups.status === 200 && groups.data.length > 0,
    groups.data.slice(0, 4).map((x) => `${x.name}:${x.count}`).join(', '));

  const failed = results.filter((r) => !r.ok);
  console.log(`\n===== 验收结果：${results.length - failed.length}/${results.length} 通过 =====`);
  if (failed.length) {
    console.log('未通过：' + failed.map((f) => f.name).join('、'));
    process.exit(1);
  }
  console.log('全部通过 ✅');
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
