/* 书源工作台 前端逻辑（零依赖） */
'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  sources: [],
  groups: [],
  page: 1,
  pageSize: 30,
  editing: null,
  lastGenerated: null,
  previewBook: null,
  previewToc: [],
  caps: { jsRender: false, mode: 'http' },
};

function toast(msg, isErr) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast' + (isErr ? ' err' : '');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), 3200);
}

async function api(path, options) {
  const res = await fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, options));
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).error || msg; } catch (e) { /* ignore */ }
    throw new Error(msg);
  }
  return res.json();
}

// ---------------- 选项卡 ----------------
$$('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('.tab').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const name = btn.dataset.tab;
    ['create', 'library', 'debug', 'help'].forEach((n) => {
      const panel = $('#panel-' + n);
      if (panel) panel.classList.toggle('active', n === name);
    });
    $('#panel-editor').classList.remove('active');
    if (name === 'library') loadLibrary();
  });
});

function showEditor() {
  ['create', 'library', 'debug', 'help'].forEach((n) => {
    const panel = $('#panel-' + n);
    if (panel) panel.classList.remove('active');
  });
  $('#panel-editor').classList.add('active');
}

// ---------------- 网址造源 ----------------
$('#btnGenerate').addEventListener('click', generate);
$('#genUrl').addEventListener('keydown', (e) => { if (e.key === 'Enter') generate(); });

async function generate() {
  const url = $('#genUrl').value.trim();
  const testKey = $('#genKey').value.trim() || '斗破苍穹';
  const useRender = $('#genRender') ? $('#genRender').checked : true;
  if (!url) { toast('请先输入网址', true); return; }
  const btn = $('#btnGenerate');
  btn.disabled = true;
  btn.textContent = '生成中…';
  $('#genProgress').classList.remove('hidden');
  $('#genLog').textContent = '';
  $('#genResult').classList.add('hidden');

  try {
    const res = await fetch('/api/generate?sse=1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, testKey, useRender }),
    });
    if (!res.ok || !res.body) throw new Error('请求失败 ' + res.status);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finalResult = null;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop();
      for (const block of blocks) {
        const ev = /^event: (.+)$/m.exec(block);
        const data = /^data: ([\s\S]+)$/m.exec(block);
        if (!ev || !data) continue;
        let payload;
        try { payload = JSON.parse(data[1]); } catch (e) { continue; }
        if (ev[1] === 'progress') {
          $('#genLog').textContent += `[${payload.stage}] ${payload.message}\n`;
          $('#genLog').scrollTop = $('#genLog').scrollHeight;
        } else if (ev[1] === 'result') finalResult = payload;
        else if (ev[1] === 'error') throw new Error(payload.message);
      }
    }
    if (!finalResult) throw new Error('生成未返回结果');
    state.lastGenerated = finalResult;
    renderGenerated(finalResult);
  } catch (e) {
    toast('生成失败: ' + e.message, true);
    $('#genLog').textContent += '\n失败: ' + e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = '开始生成';
    $('#genProgress').classList.add('hidden');
  }
}

function renderGenerated(result) {
  $('#genResult').classList.remove('hidden');
  const score = result.validation ? result.validation.score : 0;
  const el = $('#genScore');
  el.textContent = `自测得分 ${score}/100${result.ok ? ' · 全流程通过' : ''}`;
  el.className = 'score ' + (score >= 90 ? 'good' : (score >= 50 ? 'mid' : 'bad'));

  const src = result.source || {};
  $('#genRules').textContent = JSON.stringify({
    bookSourceName: src.bookSourceName,
    bookSourceUrl: src.bookSourceUrl,
    searchUrl: src.searchUrl,
    ruleSearch: src.ruleSearch,
    ruleBookInfo: src.ruleBookInfo,
    ruleToc: src.ruleToc,
    ruleContent: src.ruleContent,
  }, null, 2);

  const rep = $('#genReport');
  rep.innerHTML = '';
  if (result.validation) {
    for (const [name, step] of Object.entries(result.validation.steps)) {
      rep.appendChild(stepCard(name, step));
    }
    if (result.validation.issues && result.validation.issues.length) {
      const d = document.createElement('div');
      d.className = 'step';
      d.innerHTML = '<div class="step-head"><b>待改进</b></div>'
        + result.validation.issues.map((i) => `<div class="err">· ${escapeHtml(i)}</div>`).join('');
      rep.appendChild(d);
    }
  } else {
    rep.innerHTML = '<p class="hint">未执行校验。' + escapeHtml((result.notes || []).join('；')) + '</p>';
  }
  if (result.notes && result.notes.length) {
    const d = document.createElement('div');
    d.className = 'step';
    d.innerHTML = '<div class="step-head"><b>备注</b></div>'
      + result.notes.map((n) => `<div class="kv">· ${escapeHtml(n)}</div>`).join('');
    rep.appendChild(d);
  }
}

function stepCard(name, step) {
  const div = document.createElement('div');
  div.className = 'step';
  const ok = step && step.ok;
  const label = { search: '搜索', bookInfo: '详情', toc: '目录', content: '正文' }[name] || name;
  let detail = '';
  if (name === 'search') detail = `命中 ${step.count || 0} 本`;
  if (name === 'toc') detail = `${step.count || 0} 章`;
  if (name === 'content') detail = `${step.length || 0} 字`;
  if (name === 'bookInfo' && step.info) detail = `${step.info.name || ''} / ${step.info.author || ''}`;
  const errors = (step && step.errors || []).map((e) => `<div class="err">· ${escapeHtml(e)}</div>`).join('');
  let sample = '';
  if (name === 'search' && step.sample) {
    sample = step.sample.map((b) => `<div class="kv">· ${escapeHtml(b.name || '')} · <span class="muted">${escapeHtml(b.bookUrl || '')}</span></div>`).join('');
  }
  if (name === 'toc' && step.sample) {
    sample = `<div class="kv">${step.sample.map((c) => escapeHtml(c)).join(' / ')}</div>`;
  }
  if (name === 'content' && step.preview) {
    sample = `<div class="kv">${escapeHtml(step.preview)}</div>`;
  }
  div.innerHTML = `<div class="step-head"><b>${label}</b><span class="badge ${ok ? 'ok' : 'bad'}">${ok ? '通过' : '未通过'}</span></div>
    <div class="kv">${escapeHtml(detail)}</div>${errors}${sample}`;
  return div;
}

$('#btnSaveGen').addEventListener('click', async () => {
  if (!state.lastGenerated || !state.lastGenerated.source) return;
  await saveGenerated(state.lastGenerated.source);
});

/**
 * 保存生成的源。若该网址已在书源库里，先问清楚，避免静默覆盖别人的源。
 */
async function saveGenerated(source) {
  let existing = null;
  try {
    const info = await api('/api/library/find?url=' + encodeURIComponent(source.bookSourceUrl));
    if (info.exists) existing = info.source;
  } catch (e) { /* 查不到就按新增处理 */ }

  if (existing) {
    const msg = `书源库里已经有这个网址的源：\n\n  名称：${existing.bookSourceName}\n  网址：${existing.bookSourceUrl}\n`
      + `${existing.bookSourceGroup ? '  分组：' + existing.bookSourceGroup + '\n' : ''}`
      + `\n「确定」= 用刚生成的规则覆盖它（会丢掉它原有的发现分类等设置）\n`
      + `「取消」= 不写入，改个书源网址再保存`;
    if (!confirm(msg)) {
      toast('已取消保存：可修改「书源网址」后另存', true);
      return false;
    }
  }
  try {
    const out = await api('/api/library/source', { method: 'POST', body: JSON.stringify({ source }) });
    toast(existing ? `已覆盖「${out.source.bookSourceName}」` : `已保存「${out.source.bookSourceName}」到书源库`);
    loadLibrary();
    return true;
  } catch (e) {
    toast('保存失败: ' + e.message, true);
    return false;
  }
}

$('#btnExportGen').addEventListener('click', () => {
  if (!state.lastGenerated || !state.lastGenerated.source) return;
  downloadJson([state.lastGenerated.source], suggestName(state.lastGenerated.source));
});

$('#btnCopyGen').addEventListener('click', async () => {
  if (!state.lastGenerated || !state.lastGenerated.source) return;
  await navigator.clipboard.writeText(JSON.stringify([state.lastGenerated.source], null, 2));
  toast('已复制到剪贴板');
});

function suggestName(source) {
  return (source.bookSourceName || 'book-source').replace(/[\\/:*?"<>|]/g, '_') + '.json';
}

function downloadJson(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------------- 书源管理 ----------------
async function loadLibrary() {
  const keyword = $('#libSearch').value.trim();
  const group = $('#libGroup').value;
  const data = await api(`/api/library?keyword=${encodeURIComponent(keyword)}&group=${encodeURIComponent(group)}`);
  state.sources = data.sources;
  state.groups = data.groups;
  const sel = $('#libGroup');
  const cur = sel.value;
  sel.innerHTML = '<option value="">全部分组</option>'
    + data.groups.map((g) => `<option value="${escapeHtml(g.name)}">${escapeHtml(g.name)} (${g.count})</option>`).join('');
  sel.value = cur;
  const st = data.stats;
  $('#libStats').innerHTML = `共 <b>${st.count}</b> 个书源 · ${st.groups} 个分组 · 启用 ${st.enabled}`
    + (st.lastImport ? ` · 上次导入 ${new Date(st.lastImport.at).toLocaleString('zh-CN')}（新增 ${st.lastImport.stats.added} / 更新 ${st.lastImport.stats.updated}）` : '');
  renderTable();
}

function renderTable() {
  const body = $('#libBody');
  const total = state.sources.length;
  const pages = Math.max(1, Math.ceil(total / state.pageSize));
  if (state.page > pages) state.page = pages;
  const start = (state.page - 1) * state.pageSize;
  const rows = state.sources.slice(start, start + state.pageSize);
  body.innerHTML = rows.map((s) => `
    <tr>
      <td>${escapeHtml(s.bookSourceName || '')}</td>
      <td><span class="url" title="${escapeHtml(s.bookSourceUrl)}">${escapeHtml(s.bookSourceUrl)}</span></td>
      <td>${escapeHtml(s.bookSourceGroup || '')}</td>
      <td>${s.enabled === false ? '否' : '是'}</td>
      <td><div class="ops">
        <button class="mini" data-act="edit" data-url="${escapeHtml(s.bookSourceUrl)}">编辑</button>
        <button class="mini" data-act="validate" data-url="${escapeHtml(s.bookSourceUrl)}">校验</button>
        <button class="mini" data-act="export" data-url="${escapeHtml(s.bookSourceUrl)}">导出</button>
        <button class="mini" data-act="delete" data-url="${escapeHtml(s.bookSourceUrl)}">删除</button>
      </div></td>
    </tr>`).join('') || '<tr><td colspan="5" class="hint">还没有书源，先去「网址造源」生成，或导入 JSON 文件。</td></tr>';
  $('#libPageInfo').textContent = `${state.page} / ${pages}（共 ${total} 条）`;
}

$('#libBody').addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const url = btn.dataset.url;
  const src = state.sources.find((s) => s.bookSourceUrl === url);
  if (!src) return;
  if (btn.dataset.act === 'edit') openEditor(src);
  if (btn.dataset.act === 'export') downloadJson([src], suggestName(src));
  if (btn.dataset.act === 'delete') {
    if (!confirm(`确定删除「${src.bookSourceName}」？`)) return;
    await api('/api/library/source?url=' + encodeURIComponent(url), { method: 'DELETE' });
    toast('已删除');
    loadLibrary();
  }
  if (btn.dataset.act === 'validate') {
    btn.disabled = true; btn.textContent = '校验中…';
    try {
      const report = await api('/api/validate', { method: 'POST', body: JSON.stringify({ source: src, key: $('#genKey').value.trim() || '斗破苍穹' }) });
      toast(`${src.bookSourceName}: 得分 ${report.score}/100`);
      openEditor(src);
      renderEditReport(report);
    } catch (err) { toast('校验失败: ' + err.message, true); }
    btn.disabled = false; btn.textContent = '校验';
  }
});

$('#libSearch').addEventListener('input', debounce(loadLibrary, 300));
$('#libGroup').addEventListener('change', () => { state.page = 1; loadLibrary(); });
$('#libPrev').addEventListener('click', () => { state.page = Math.max(1, state.page - 1); renderTable(); });
$('#libNext').addEventListener('click', () => { state.page += 1; renderTable(); });

$('#btnImportFile').addEventListener('click', () => $('#fileInput').click());
$('#fileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();
  await doImport(text, file.name);
  e.target.value = '';
});

$('#btnImportSample').addEventListener('click', async () => {
  const res = await fetch('/api/sample');
  if (!res.ok) { toast('找不到示例文件', true); return; }
  const data = await res.json();
  await doImport(JSON.stringify(data.sources), data.fileName);
});

async function doImport(text, fileName) {
  let sources;
  try { sources = JSON.parse(text); } catch (err) { toast('JSON 解析失败: ' + err.message, true); return; }
  if (!Array.isArray(sources) && sources.sources) sources = sources.sources;
  if (!Array.isArray(sources)) { toast('文件格式不对：应为书源数组', true); return; }
  try {
    const out = await api('/api/library/import', { method: 'POST', body: JSON.stringify({ sources, fileName }) });
    toast(`导入完成：新增 ${out.stats.added}，更新 ${out.stats.updated}，跳过 ${out.stats.skipped}，共 ${out.total} 个书源`);
    state.page = 1;
    loadLibrary();
  } catch (e) { toast('导入失败: ' + e.message, true); }
}

$('#btnExportAll').addEventListener('click', async () => {
  const data = await api('/api/library/export');
  if (!data.length) { toast('书源库是空的', true); return; }
  downloadJson(data, `书源合集_${data.length}个_${new Date().toISOString().slice(0, 10)}.json`);
});

// ---------------- 编辑器 ----------------
const RULE_FIELDS = {
  search: ['bookList', 'name', 'author', 'kind', 'wordCount', 'lastChapter', 'intro', 'coverUrl', 'bookUrl'],
  BookInfo: ['name', 'author', 'kind', 'wordCount', 'lastChapter', 'intro', 'coverUrl', 'tocUrl'],
  Toc: ['chapterList', 'chapterName', 'chapterUrl', 'nextTocUrl', 'updateTime'],
  Content: ['content', 'nextContentUrl', 'title', 'replaceRegex'],
};
const GROUP_KEY = { search: 'ruleSearch', BookInfo: 'ruleBookInfo', Toc: 'ruleToc', Content: 'ruleContent' };

function openEditor(source) {
  state.editing = JSON.parse(JSON.stringify(source));
  showEditor();
  $('#editName').textContent = source.bookSourceName || '';
  $('#f_name').value = source.bookSourceName || '';
  $('#f_url').value = source.bookSourceUrl || '';
  $('#f_group').value = source.bookSourceGroup || '';
  $('#f_searchUrl').value = source.searchUrl || '';
  $('#f_exploreUrl').value = source.exploreUrl || '';
  $('#f_header').value = source.header || '';
  for (const [group, fields] of Object.entries(RULE_FIELDS)) {
    const container = $('#rules-' + group);
    const data = source[GROUP_KEY[group]] || {};
    container.innerHTML = fields.map((f) => `
      <div class="rule-item">
        <label>${f}</label>
        <input type="text" data-group="${GROUP_KEY[group]}" data-field="${f}" value="${escapeAttr(data[f] || '')}">
      </div>`).join('');
  }
  $('#editReport').innerHTML = '<p class="hint">点「真机校验」跑一遍搜索→详情→目录→正文。</p>';
  $('#editPreview').innerHTML = '';
}

$('#btnBackLib').addEventListener('click', () => {
  $('#panel-editor').classList.remove('active');
  $('#panel-library').classList.add('active');
  $$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === 'library'));
  loadLibrary();
});

function collectEditor() {
  const src = JSON.parse(JSON.stringify(state.editing || {}));
  src.bookSourceName = $('#f_name').value.trim();
  src.bookSourceUrl = $('#f_url').value.trim().replace(/\/+$/, '');
  src.bookSourceGroup = $('#f_group').value.trim();
  src.searchUrl = $('#f_searchUrl').value.trim();
  src.exploreUrl = $('#f_exploreUrl').value.trim();
  src.header = $('#f_header').value.trim();
  src.enabledExplore = !!src.exploreUrl;
  for (const [group, fields] of Object.entries(RULE_FIELDS)) {
    const key = GROUP_KEY[group];
    src[key] = src[key] || {};
    for (const f of fields) {
      const input = document.querySelector(`input[data-group="${key}"][data-field="${f}"]`);
      src[key][f] = input ? input.value.trim() : (src[key][f] || '');
    }
  }
  return src;
}

$('#btnSaveEdit').addEventListener('click', async () => {
  const src = collectEditor();
  if (!src.bookSourceUrl) { toast('书源网址不能为空', true); return; }
  try {
    await api('/api/library/source', { method: 'POST', body: JSON.stringify({ source: src }) });
    state.editing = src;
    toast('已保存');
  } catch (e) { toast('保存失败: ' + e.message, true); }
});

$('#btnValidateEdit').addEventListener('click', async () => {
  const src = collectEditor();
  const btn = $('#btnValidateEdit');
  btn.disabled = true; btn.textContent = '校验中…';
  $('#editReport').innerHTML = '<p class="hint">正在真机校验，请稍候…</p>';
  try {
    const report = await api('/api/validate', { method: 'POST', body: JSON.stringify({ source: src, key: $('#genKey').value.trim() || '斗破苍穹' }) });
    renderEditReport(report);
  } catch (e) {
    $('#editReport').innerHTML = `<p class="err">校验失败: ${escapeHtml(e.message)}</p>`;
  }
  btn.disabled = false; btn.textContent = '真机校验';
});

$('#btnAiFill').addEventListener('click', async () => {
  const url = $('#f_url').value.trim() || $('#genUrl').value.trim();
  if (!url) { toast('请先填书源网址', true); return; }
  const btn = $('#btnAiFill');
  btn.disabled = true; btn.textContent = '嗅探中…';
  try {
    const result = await api('/api/generate', { method: 'POST', body: JSON.stringify({ url, testKey: $('#genKey').value.trim() || '斗破苍穹', useRender: $('#genRender') ? $('#genRender').checked : true }) });
    const src = result.source;
    if (!src) throw new Error('未生成规则');
    $('#f_searchUrl').value = src.searchUrl || '';
    for (const [group, fields] of Object.entries(RULE_FIELDS)) {
      const key = GROUP_KEY[group];
      for (const f of fields) {
        const input = document.querySelector(`input[data-group="${key}"][data-field="${f}"]`);
        if (input && src[key] && src[key][f]) input.value = src[key][f];
      }
    }
    if (result.validation) renderEditReport(result.validation);
    toast('已根据网站结构填充规则，请核对后保存');
  } catch (e) { toast('嗅探失败: ' + e.message, true); }
  btn.disabled = false; btn.textContent = '智能补全规则';
});

function renderEditReport(report) {
  const el = $('#editReport');
  el.innerHTML = `<p><span class="score ${report.score >= 90 ? 'good' : report.score >= 50 ? 'mid' : 'bad'}">得分 ${report.score}/100</span></p>`;
  for (const [name, step] of Object.entries(report.steps || {})) {
    el.appendChild(stepCard(name, step));
  }
  if (report.issues && report.issues.length) {
    const d = document.createElement('div');
    d.className = 'step';
    d.innerHTML = '<div class="step-head"><b>问题</b></div>'
      + report.issues.map((i) => `<div class="err">· ${escapeHtml(i)}</div>`).join('');
    el.appendChild(d);
  }
}

$$('.preview-tabs button').forEach((btn) => {
  btn.addEventListener('click', async () => {
    $$('.preview-tabs button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    await runPreview(btn.dataset.preview);
  });
});

async function runPreview(kind) {
  const src = collectEditor();
  const el = $('#editPreview');
  const key = $('#genKey').value.trim() || '斗破苍穹';
  el.innerHTML = '<p class="hint">加载中…</p>';
  try {
    if (kind === 'search') {
      const data = await api('/api/preview/search', { method: 'POST', body: JSON.stringify({ source: src, key }) });
      state.previewBook = data.books[0] || null;
      el.innerHTML = `<p class="hint">命中 ${data.count} 本 · ${escapeHtml((data.urls || [])[0] || '')}</p>`
        + (data.errors || []).map((x) => `<div class="err">${escapeHtml(x)}</div>`).join('')
        + data.books.map((b) => `<div class="book"><b>${escapeHtml(b.name)}</b> <small>${escapeHtml(b.author || '')}</small>
            <div class="kv">${escapeHtml(b.bookUrl || '')}</div>
            <div class="kv muted">${escapeHtml((b.kind || '') + ' ' + (b.lastChapter || ''))}</div></div>`).join('');
    } else if (kind === 'bookInfo') {
      if (!state.previewBook) throw new Error('请先执行“搜索”预览以取得书籍');
      const data = await api('/api/preview/bookInfo', { method: 'POST', body: JSON.stringify({ source: src, bookUrl: state.previewBook.bookUrl }) });
      const info = data.info || {};
      el.innerHTML = `<div class="book"><b>${escapeHtml(info.name || '')}</b> <small>${escapeHtml(info.author || '')}</small></div>
        ${info.coverUrl ? `<img class="cover" src="${escapeAttr(info.coverUrl)}">` : ''}
        <div class="kv">分类: ${escapeHtml(info.kind || '')}</div>
        <div class="kv">最新: ${escapeHtml(info.lastChapter || '')}</div>
        <div class="kv">简介: ${escapeHtml((info.intro || '').slice(0, 600))}</div>
        ${(data.errors || []).map((x) => `<div class="err">${escapeHtml(x)}</div>`).join('')}`;
    } else if (kind === 'toc') {
      if (!state.previewBook) throw new Error('请先执行“搜索”预览以取得书籍');
      const data = await api('/api/preview/toc', { method: 'POST', body: JSON.stringify({ source: src, bookUrl: state.previewBook.bookUrl }) });
      state.previewToc = data.chapters || [];
      el.innerHTML = `<p class="hint">共 ${data.count} 章</p>`
        + (data.errors || []).map((x) => `<div class="err">${escapeHtml(x)}</div>`).join('')
        + data.chapters.slice(0, 100).map((c, i) => `<div class="chapter">${i + 1}. ${escapeHtml(c.name)}</div>`).join('');
    } else if (kind === 'content') {
      if (!state.previewToc.length) throw new Error('请先执行“目录”预览');
      const ch = state.previewToc[0];
      const data = await api('/api/preview/content', { method: 'POST', body: JSON.stringify({ source: src, chapterUrl: ch.url }) });
      el.innerHTML = `<p class="hint">${escapeHtml(ch.name)} · ${data.length} 字 · 共 ${(data.pages || []).length} 页</p>`
        + (data.errors || []).map((x) => `<div class="err">${escapeHtml(x)}</div>`).join('')
        + `<div>${escapeHtml(data.text || '').replace(/\n/g, '<br>')}</div>`;
    }
  } catch (e) {
    el.innerHTML = `<div class="err">${escapeHtml(e.message)}</div>`;
  }
}

// ---------------- 规则调试 ----------------
$('#btnDbgFetch').addEventListener('click', async () => {
  const url = $('#dbgUrl').value.trim();
  if (!url) { toast('请输入网址', true); return; }
  $('#dbgHtml').textContent = '抓取中…';
  try {
    const data = await api('/api/fetch', { method: 'POST', body: JSON.stringify({ url }) });
    $('#dbgHtml').textContent = `HTTP ${data.status} · ${data.charset} · ${data.length} 字节\n\n` + data.body.slice(0, 4000);
    toast('抓取成功');
  } catch (e) { $('#dbgHtml').textContent = '抓取失败: ' + e.message; }
});

$('#btnDbgEval').addEventListener('click', async () => {
  const url = $('#dbgUrl').value.trim();
  const rules = $('#dbgRules').value.split('\n').map((x) => x.trim()).filter(Boolean);
  if (!url || !rules.length) { toast('请填写网址和规则', true); return; }
  try {
    const data = await api('/api/eval', { method: 'POST', body: JSON.stringify({ url, rules }) });
    const el = $('#dbgResult');
    el.innerHTML = `<p class="hint">HTTP ${data.response ? data.response.status : '-'} · ${data.response ? data.response.length : 0} 字节</p>`
      + Object.entries(data.results).map(([rule, r]) => {
        if (r.error) return `<div class="step"><b>${escapeHtml(rule)}</b><div class="err">${escapeHtml(r.error)}</div></div>`;
        return `<div class="step"><div class="step-head"><b>${escapeHtml(rule)}</b><span class="badge ${r.count ? 'ok' : 'bad'}">${r.count} 个结果</span></div>
          <div class="kv">${r.values.map((v) => escapeHtml(String(v).slice(0, 200))).join('<br>')}</div></div>`;
      }).join('');
  } catch (e) { toast('执行失败: ' + e.message, true); }
});

// JS 渲染效果对比
$('#btnDbgRender').addEventListener('click', async () => {
  const url = $('#dbgUrl').value.trim();
  if (!url) { toast('请先填写网址', true); return; }
  const btn = $('#btnDbgRender');
  btn.disabled = true; btn.textContent = '渲染中…';
  const el = $('#dbgRenderResult');
  el.innerHTML = '<p class="hint">正在对比普通抓取与浏览器渲染…</p>';
  try {
    const d = await api('/api/render-test', { method: 'POST', body: JSON.stringify({ url }) });
    const plainLen = d.plain ? (d.plain.length || 0) : 0;
    const renderLen = d.rendered ? d.rendered.length : 0;
    el.innerHTML = `
      <div class="step">
        <div class="step-head"><b>普通 HTTP 抓取</b><span class="badge ${d.needed ? 'bad' : 'ok'}">${plainLen} 字节</span></div>
        <div class="kv">${d.needed ? '判定：' + escapeHtml(d.reason) : '判定：内容正常，不需要渲染'}</div>
      </div>
      ${d.rendered ? `<div class="step">
        <div class="step-head"><b>浏览器渲染</b><span class="badge ${d.improved ? 'ok' : 'bad'}">${renderLen} 字节 · 文本 ${d.rendered.chars} 字</span></div>
        <div class="kv">最终地址：${escapeHtml(d.rendered.finalUrl || '')}</div>
        <div class="kv">${escapeHtml(d.preview || '')}</div>
      </div>` : `<div class="step"><div class="kv">${d.renderAvailable ? '未触发渲染' : '当前是浏览器模式，没有 JS 渲染能力（用「启动桌面客户端.bat」启动可用）'}</div></div>`}
      ${d.renderError ? `<div class="step"><div class="err">渲染错误：${escapeHtml(d.renderError)}</div></div>` : ''}`;
  } catch (e) {
    el.innerHTML = `<div class="err">${escapeHtml(e.message)}</div>`;
  }
  btn.disabled = false; btn.textContent = '对比 JS 渲染效果';
});

// ---------------- 工具 ----------------
function escapeHtml(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escapeAttr(s) { return escapeHtml(s); }

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// ---------------- 启动 ----------------
(async function init() {
  try {
    const h = await api('/api/health');
    $('#serverStatus').textContent = '本地服务已连接 · v' + h.version;
    $('#serverStatus').className = 'status ok';
  } catch (e) {
    $('#serverStatus').textContent = '无法连接本地服务';
    $('#serverStatus').className = 'status err';
  }
  try {
    state.caps = await api('/api/capabilities');
  } catch (e) { /* 保持默认：无渲染能力 */ }
  if (state.caps.jsRender) {
    $('#genRenderWrap').classList.remove('hidden');
    $('#btnDbgRender').classList.remove('hidden');
  }
  loadLibrary();
})();
