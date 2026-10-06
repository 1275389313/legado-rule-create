'use strict';
/**
 * 自动生成书源（命令行调试）：
 *   node scripts/gen.js <网址> [测试关键字]
 */

const { SourceGenerator } = require('../src/core/generator');

async function main() {
  const url = process.argv[2];
  const key = process.argv[3];
  if (!url) {
    console.log('用法: node scripts/gen.js <网址> [测试关键字]');
    process.exit(1);
  }
  const gen = new SourceGenerator({
    testKey: key,
    log: (m) => console.log('  ' + m),
  });
  const t0 = Date.now();
  const result = await gen.generate(url, { testKey: key });
  console.log('\n耗时', ((Date.now() - t0) / 1000).toFixed(1), 's');
  console.log('站点:', result.siteUrl, '名称:', result.name);
  console.log('步骤:');
  for (const s of result.steps) console.log('  -', s.step, s.ok ? 'OK' : 'FAIL', JSON.stringify(s.info || {}).slice(0, 200));
  console.log('\n生成的 searchUrl:', result.source && result.source.searchUrl);
  console.log('ruleSearch:', JSON.stringify(result.source && result.source.ruleSearch, null, 1));
  console.log('ruleBookInfo:', JSON.stringify(result.source && result.source.ruleBookInfo, null, 1));
  console.log('ruleToc:', JSON.stringify(result.source && result.source.ruleToc, null, 1));
  console.log('ruleContent:', JSON.stringify(result.source && result.source.ruleContent, null, 1));
  if (result.validation) {
    console.log('\n自测得分:', result.validation.score, 'ok=', result.validation.ok);
    console.log(JSON.stringify(result.validation.steps, null, 1).slice(0, 2500));
    console.log('issues:', result.validation.issues);
  }
  if (result.notes.length) console.log('\n备注:', result.notes);
  require('fs').writeFileSync('scripts/out-generated.json', JSON.stringify(result.source, null, 2));
  console.log('\n已写入 scripts/out-generated.json');
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
