'use strict';
/**
 * 书源库：管理本地书源集合（导入/导出/增删改查/去重/分组）。
 */

const fs = require('fs');
const path = require('path');

class SourceLibrary {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'sources.json');
    this.metaFile = path.join(dataDir, 'meta.json');
    this.sources = [];
    this.meta = { history: [], lastImport: null };
    this.ensureDir();
    this.load();
  }

  ensureDir() {
    if (!fs.existsSync(this.dataDir)) fs.mkdirSync(this.dataDir, { recursive: true });
  }

  load() {
    try {
      if (fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this.sources = Array.isArray(raw) ? raw : (raw.sources || []);
      }
      if (fs.existsSync(this.metaFile)) {
        this.meta = JSON.parse(fs.readFileSync(this.metaFile, 'utf8'));
      }
    } catch (e) {
      this.sources = [];
    }
    return this;
  }

  save() {
    this.ensureDir();
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.sources, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
    fs.writeFileSync(this.metaFile, JSON.stringify(this.meta, null, 2), 'utf8');
  }

  /** 导入书源（数组或 {sources:[]}），按 bookSourceUrl 去重合并 */
  import(data, opts = {}) {
    const list = Array.isArray(data) ? data : (data && Array.isArray(data.sources) ? data.sources : []);
    const stats = { total: list.length, added: 0, updated: 0, skipped: 0, invalid: 0 };
    // 索引必须用“归一化后的 url”作为键，否则带/不带尾斜杠的同一书源会被当成两个
    const keyOf = (s) => String(s.bookSourceUrl || '').replace(/\/+$/, '');
    const index = new Map();
    this.sources.forEach((s, i) => { if (!index.has(keyOf(s))) index.set(keyOf(s), i); });
    for (const raw of list) {
      if (!raw || typeof raw !== 'object' || !raw.bookSourceUrl) { stats.invalid++; continue; }
      const normalized = normalizeSource(raw);
      const key = keyOf(normalized);
      if (index.has(key)) {
        if (opts.overwrite === false) { stats.skipped++; continue; }
        this.sources[index.get(key)] = Object.assign({}, this.sources[index.get(key)], normalized);
        stats.updated++;
      } else {
        index.set(key, this.sources.length);
        this.sources.push(normalized);
        stats.added++;
      }
    }
    this.meta.lastImport = { at: Date.now(), file: opts.fileName || '', stats };
    this.save();
    return stats;
  }

  list(query = {}) {
    let list = this.sources.slice();
    if (query.group) list = list.filter((s) => (s.bookSourceGroup || '') === query.group);
    if (query.keyword) {
      const k = String(query.keyword).toLowerCase();
      list = list.filter((s) => (s.bookSourceName || '').toLowerCase().includes(k)
        || (s.bookSourceUrl || '').toLowerCase().includes(k));
    }
    if (query.enabled === 'true') list = list.filter((s) => s.enabled !== false);
    return list;
  }

  get(url) {
    return this.sources.find((s) => s.bookSourceUrl === url) || null;
  }

  upsert(source) {
    if (!source || !source.bookSourceUrl) throw new Error('书源缺少 bookSourceUrl');
    const normalized = normalizeSource(source);
    const i = this.sources.findIndex((s) => s.bookSourceUrl === normalized.bookSourceUrl);
    if (i >= 0) this.sources[i] = Object.assign({}, this.sources[i], normalized);
    else this.sources.push(normalized);
    this.save();
    return normalized;
  }

  remove(url) {
    const before = this.sources.length;
    this.sources = this.sources.filter((s) => s.bookSourceUrl !== url);
    this.save();
    return before !== this.sources.length;
  }

  groups() {
    const m = new Map();
    for (const s of this.sources) {
      const g = s.bookSourceGroup || '(未分组)';
      m.set(g, (m.get(g) || 0) + 1);
    }
    return [...m.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  }

  export(urls) {
    const set = urls && urls.length ? new Set(urls) : null;
    return this.sources.filter((s) => !set || set.has(s.bookSourceUrl));
  }

  stats() {
    return {
      count: this.sources.length,
      groups: this.groups().length,
      enabled: this.sources.filter((s) => s.enabled !== false).length,
      lastImport: this.meta.lastImport,
    };
  }
}

const EMPTY_RULES = {
  ruleSearch: ['bookList', 'name', 'author', 'kind', 'wordCount', 'lastChapter', 'intro', 'coverUrl', 'bookUrl'],
  ruleExplore: ['bookList', 'name', 'author', 'kind', 'wordCount', 'lastChapter', 'intro', 'coverUrl', 'bookUrl'],
  ruleBookInfo: ['init', 'name', 'author', 'kind', 'wordCount', 'lastChapter', 'intro', 'coverUrl', 'tocUrl'],
  ruleToc: ['chapterList', 'chapterName', 'chapterUrl', 'nextTocUrl', 'updateTime', 'isVip', 'isVolume'],
  ruleContent: ['content', 'nextContentUrl', 'title', 'replaceRegex', 'webJs', 'sourceRegex'],
};

function normalizeSource(raw) {
  const out = Object.assign({}, raw);
  out.bookSourceName = out.bookSourceName || out.bookSourceUrl || '未命名';
  out.bookSourceUrl = String(out.bookSourceUrl || '').replace(/\/+$/, '');
  out.bookSourceGroup = out.bookSourceGroup || '';
  out.bookSourceType = out.bookSourceType === undefined ? 0 : out.bookSourceType;
  out.enabled = out.enabled !== false;
  out.enabledExplore = out.enabledExplore === undefined ? !!out.exploreUrl : out.enabledExplore;
  out.customOrder = out.customOrder || 0;
  out.weight = out.weight || 0;
  out.searchUrl = out.searchUrl || '';
  out.exploreUrl = out.exploreUrl || '';
  out.header = out.header || '';
  for (const [group, fields] of Object.entries(EMPTY_RULES)) {
    const g = Object.assign({}, out[group] || {});
    for (const f of fields) if (g[f] === undefined) g[f] = '';
    out[group] = g;
  }
  return out;
}

module.exports = { SourceLibrary, normalizeSource, EMPTY_RULES };
