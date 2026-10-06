'use strict';
const fs = require('fs');
const path = require('path');
const { SourceLibrary } = require('../src/server/library');

const dir = path.join(__dirname, '..', '.tmp-libtest');
fs.rmSync(dir, { recursive: true, force: true });
const lib = new SourceLibrary(dir);
const sample = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '折黎No.0051.json'), 'utf8'));
console.log('样本条数:', sample.length);
console.log('样本内唯一 bookSourceUrl 数:', new Set(sample.map((s) => s.bookSourceUrl)).size);
const s1 = lib.import(sample, { fileName: 'x' });
console.log('第 1 次导入:', JSON.stringify(s1), 'lib=', lib.sources.length);
const s2 = lib.import(sample, { fileName: 'x' });
console.log('第 2 次导入:', JSON.stringify(s2), 'lib=', lib.sources.length);
// 找出“新增”的那些到底是什么
const before = new Set();
const fresh = new SourceLibrary(path.join(dir, 'second'));
const r = fresh.import(sample, {});
console.log('全新库导入:', JSON.stringify(r), '=>', fresh.sources.length);
const dupes = fresh.sources.filter((s, i, arr) => arr.findIndex((x) => x.bookSourceUrl === s.bookSourceUrl) !== i);
console.log('库内重复 URL 数:', dupes.length);
// 检查归一化是否改变了 URL
const changed = sample.filter((s) => String(s.bookSourceUrl || '').replace(/\/+$/, '') !== s.bookSourceUrl);
console.log('URL 因去尾斜杠而变化的条数:', changed.length, changed.slice(0, 3).map((s) => `${s.bookSourceUrl} -> ${String(s.bookSourceUrl).replace(/\/+$/, '')}`).join(' | '));
fs.rmSync(dir, { recursive: true, force: true });
