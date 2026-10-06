'use strict';
/** 交叉检查：前端 JS 引用的 DOM id / data 属性是否都存在于 index.html */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'js', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'css', 'app.css'), 'utf8');

const ids = new Set([...html.matchAll(/id="([\w-]+)"/g)].map((m) => m[1]));
const classes = new Set([...html.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/)));
const used = new Set([
  ...[...js.matchAll(/\$\('#([\w-]+)'\)/g)].map((m) => m[1]),
  ...[...js.matchAll(/\$\$\('\.([\w-]+)'\)/g)].map((m) => m[1]),
]);
const missing = [...used].filter((u) => !ids.has(u) && !classes.has(u));
console.log('HTML id 数:', ids.size, ' JS 引用:', used.size);
console.log('缺失:', missing.length ? missing.join(', ') : '(无)');

// CSS 里定义的类是否覆盖 JS/HTML 用到的关键类
const important = ['panel', 'active', 'tab', 'card', 'table', 'step', 'badge', 'toast', 'preview', 'rules', 'rule-item', 'score', 'hidden'];
const missCss = important.filter((c) => !css.includes('.' + c));
console.log('CSS 缺失关键类:', missCss.length ? missCss.join(', ') : '(无)');

// 检查 onclick/handler 绑定的按钮是否都存在
const btnIds = ['btnGenerate', 'btnSaveGen', 'btnExportGen', 'btnCopyGen', 'btnImportFile', 'btnImportSample',
  'btnExportAll', 'btnSaveEdit', 'btnValidateEdit', 'btnAiFill', 'btnBackLib', 'btnDbgFetch', 'btnDbgEval',
  'libPrev', 'libNext'];
const missBtn = btnIds.filter((b) => !ids.has(b));
console.log('按钮缺失:', missBtn.length ? missBtn.join(', ') : '(无)');
