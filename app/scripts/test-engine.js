'use strict';
/**
 * 快速自测脚本：用真实书源跑一遍完整校验。
 * 用法： node scripts/test-engine.js [书源名关键字] [搜索关键字]
 */

const fs = require('fs');
const path = require('path');
const { SourceSession } = require('../src/core/session');

const ROOT = path.resolve(__dirname, '..', '..');
const SAMPLE = path.join(ROOT, '折黎No.0051.json');

async function main() {
  const filter = process.argv[2] || '混混';
  const key = process.argv[3] || '斗破苍穹';
  const all = JSON.parse(fs.readFileSync(SAMPLE, 'utf8'));
  const source = all.find((s) => String(s.bookSourceName || '').includes(filter));
  if (!source) {
    console.log('未找到书源:', filter);
    console.log('可用示例:', all.slice(0, 10).map((s) => s.bookSourceName).join(', '));
    process.exit(1);
  }
  console.log('书源:', source.bookSourceName, source.bookSourceUrl);
  console.log('searchUrl:', source.searchUrl);
  const session = new SourceSession(source, { log: (m) => console.log('  [log]', m) });
  const report = await session.validate(key, { maxPages: 2 });
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
