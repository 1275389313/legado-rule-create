'use strict';
/** 针对某个书源做详细链路诊断 */
const fs = require('fs');
const path = require('path');
const { SourceSession } = require('../src/core/session');

const ROOT = path.resolve(__dirname, '..', '..');

async function main() {
  const keyword = process.argv[2] || '键盘';
  const key = process.argv[3] || '斗破苍穹';
  const all = JSON.parse(fs.readFileSync(path.join(ROOT, '折黎No.0051.json'), 'utf8'));
  const source = all.find((s) => String(s.bookSourceName || '').includes(keyword));
  if (!source) { console.log('未找到书源:', keyword); return; }
  console.log('书源:', source.bookSourceName, source.bookSourceUrl);
  console.log('searchUrl:', source.searchUrl);
  console.log('ruleSearch:', JSON.stringify(source.ruleSearch));
  console.log('ruleBookInfo:', JSON.stringify(source.ruleBookInfo));
  console.log('ruleToc:', JSON.stringify(source.ruleToc));
  console.log('ruleContent:', JSON.stringify(source.ruleContent));

  const session = new SourceSession(source, { timeout: 15000, log: (m) => console.log('  [log]', m) });
  const search = await session.search(key, 1);
  console.log('\n搜索:', search.ok, search.books.length, '本', search.errors[0] || '');
  if (!search.ok) return;
  const book = search.books[0];
  console.log('第一本:', book.name, '|', book.bookUrl);
  const info = await session.bookInfo(book);
  console.log('\n详情 ok=', info.ok, 'errors=', info.errors.join('; '));
  console.log('info=', JSON.stringify(info.info));
  const merged = Object.assign({}, book, info.info || {});
  const toc = await session.toc(merged, info.html);
  console.log('\n目录 ok=', toc.ok, '章数=', toc.chapters.length, 'errors=', toc.errors.join('; '));
  console.log('前 3 章:', toc.chapters.slice(0, 3).map((c) => `${c.name} -> ${c.url}`).join(' | '));
  if (toc.chapters.length) {
    const content = await session.content(merged, toc.chapters[0], { maxPages: 2 });
    console.log('\n正文 ok=', content.ok, '长度=', content.length, 'errors=', content.errors.join('; '));
    console.log('预览:', (content.text || '').slice(0, 200));
    console.log('pages:', JSON.stringify(content.pages));
  }
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
