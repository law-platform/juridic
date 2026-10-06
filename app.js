'use strict';

const PAGE_SIZE = 50;
const FUZZY_LIMIT = 200;
const PREVIEW_CHARS = 120;
const KWIC_CHARS = 40;
const KWIC_MAX = 3;
const LANG_LABEL = { ja: '日', fr: '仏', en: '英', de: '独', la: '羅' };
const POS_LABEL = {
  noun: '名詞', verb: '動詞', adjective: '形容詞', adverb: '副詞',
  multiWordExpression: '熟語', masculineNoun: '男性名詞', feminineNoun: '女性名詞',
};

const $ = (id) => document.getElementById(id);

const state = {
  dicts: [],
  entries: [],
  byId: new Map(),
  defs: null,         // id → 語釈（原文）
  defsN: null,        // id → 語釈（正規化済み）
  defsPromise: null,
  mini: null,
  results: [],
  shown: 0,
  matcher: null,
  mode: 'head',
  entryView: false,   // ?id= で1項目を表示中
};

// ---------------------------------------------------------------- 正規化
// 1文字ずつ正規化し、UTF-16 の長さを変えない。正規化後の文字列で見つけた位置が
// そのまま原文の位置になるので、強調表示を原文に戻せる。

let OLD2NEW = {};
const normCache = new Map();

function normChar(ch) {
  let r = normCache.get(ch);
  if (r !== undefined) return r;
  // 全角英数→半角、アクセント除去、小文字化
  r = ch.normalize('NFKD').replace(/[̀-ͯ]/g, '').normalize('NFC').toLowerCase();
  // 旧字→新字
  r = OLD2NEW[r] || r;
  // カタカナ→ひらがな
  if (r.length === 1) {
    const c = r.charCodeAt(0);
    if (c >= 0x30a1 && c <= 0x30f6) r = String.fromCharCode(c - 0x60);
  }
  if (r.length !== ch.length) {
    r = ch.toLowerCase();
    if (r.length !== ch.length) r = ch;
  }
  normCache.set(ch, r);
  return r;
}

function norm(s) {
  let out = '';
  for (const ch of s) out += normChar(ch);
  return out;
}

// ---------------------------------------------------------------- 照合器
// matcher(normalizedText) → [[start, end], ...]

function termMatcher(terms) {
  return (text) => {
    const ranges = [];
    for (const t of terms) {
      let i = text.indexOf(t);
      while (i !== -1) {
        ranges.push([i, i + t.length]);
        i = text.indexOf(t, i + t.length);
      }
    }
    return ranges;
  };
}

function mergeRanges(ranges) {
  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const out = [];
  for (const r of ranges) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

function esc(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function highlight(text, ranges) {
  if (!ranges || !ranges.length) return esc(text);
  let html = '';
  let pos = 0;
  for (const [s, e] of ranges) {
    html += esc(text.slice(pos, s)) + '<mark>' + esc(text.slice(s, e)) + '</mark>';
    pos = e;
  }
  return html + esc(text.slice(pos));
}

function hl(text) {
  if (!state.matcher) return esc(text);
  return highlight(text, mergeRanges(state.matcher(norm(text))));
}

// ---------------------------------------------------------------- 読み込み

async function load() {
  const res = await fetch('data/entries.json');
  if (!res.ok) throw new Error(`entries.json: HTTP ${res.status}`);
  const data = await res.json();
  OLD2NEW = data.old2new;
  state.dicts = data.dicts;
  state.entries = data.entries;
  state.entries.forEach((e, i) => {
    e.i = i;
    e._h = e.h.map(norm);
    e._r = (e.r || []).map(norm);
    e._t = (e.t || []).map(([, s]) => norm(s));
    state.byId.set(e.id, e);
  });

  state.mini = new MiniSearch({
    idField: 'i',
    fields: ['h', 'r', 't'],
    // 正規化は事前に済ませているので、ここでは何もしない
    processTerm: (t) => t,
  });
  state.mini.addAll(state.entries.map((e) => ({
    i: e.i, h: e._h.join(' '), r: e._r.join(' '), t: e._t.join(' '),
  })));

  state.defsPromise = fetch('data/defs.json')
    .then((r) => {
      if (!r.ok) throw new Error(`defs.json: HTTP ${r.status}`);
      return r.json();
    })
    .then((d) => {
      state.defs = d;
      updateStatus();
      return d;
    });
  state.defsPromise.catch((err) => showError(err));
}

function ensureDefsN() {
  if (state.defsN) return;
  state.defsN = {};
  for (const [id, s] of Object.entries(state.defs)) state.defsN[id] = norm(s);
}

// ---------------------------------------------------------------- 検索

function getOptions() {
  const included = [...document.querySelectorAll('#dict-filter input')]
    .filter((x) => x.checked).map((x) => Number(x.value));
  return {
    q: $('q').value.trim(),
    mode: document.querySelector('input[name=mode]:checked').value,
    dicts: new Set(included),
  };
}

function splitTerms(q) {
  return q.split(/[\s　]+/).filter(Boolean).map(norm);
}

// 見出し語・読み・対訳語の部分一致。全語を含むもののみ（AND）。完全一致・前方一致を上位に
function scoreHead(e, terms) {
  let total = 0;
  for (const t of terms) {
    let best = 0;
    for (const h of e._h) {
      if (h === t) best = Math.max(best, 100);
      else if (h.startsWith(t)) best = Math.max(best, 60);
      else if (h.includes(t)) best = Math.max(best, 30);
    }
    for (const r of e._r) {
      if (r === t) best = Math.max(best, 80);
      else if (r.startsWith(t)) best = Math.max(best, 50);
      else if (r.includes(t)) best = Math.max(best, 20);
    }
    for (const s of e._t) {
      if (s === t) best = Math.max(best, 70);
      else if (s.startsWith(t)) best = Math.max(best, 40);
      else if ((' ' + s).includes(' ' + t)) best = Math.max(best, 35);
      else if (s.includes(t)) best = Math.max(best, 15);
    }
    if (best === 0) return 0;
    total += best;
  }
  return total;
}

function searchHead(opt, terms) {
  const hits = [];
  for (const e of state.entries) {
    if (!opt.dicts.has(e.d)) continue;
    const s = scoreHead(e, terms);
    if (s > 0) hits.push({ e, s });
  }
  hits.sort((a, b) => b.s - a.s || a.e._h[0].length - b.e._h[0].length || a.e.i - b.e.i);
  const results = hits.map((h) => h.e);

  // 綴りの揺れは欧文の語だけ（漢字・かなに編集距離を当てると別語ばかり拾う）
  if (terms.some(isLatin)) {
    const found = new Set(results.map((e) => e.i));
    const extra = state.mini
      .search(terms.join(' '), {
        prefix: true,
        fuzzy: (t) => (isLatin(t) ? 0.2 : false),
        combineWith: 'AND',
      })
      .map((r) => state.entries[r.id])
      .filter((e) => !found.has(e.i) && opt.dicts.has(e.d))
      .slice(0, FUZZY_LIMIT);
    extra.forEach((e) => { e._fuzzy = true; });
    results.push(...extra);
  }
  return results;
}

function isLatin(t) {
  return /^[a-z][a-z'-]*$/.test(t);
}

// 見出し・対訳語・語釈の部分一致（AND）。見出し側に一致するものを上位に、次いで語釈中の出現回数順
function searchFull(opt, terms) {
  ensureDefsN();
  const hits = [];
  for (const e of state.entries) {
    if (!opt.dicts.has(e.d)) continue;
    const head = [...e._h, ...e._r, ...e._t].join('\n');
    const def = state.defsN[e.id] || '';
    let s = 0;
    let ok = true;
    for (const t of terms) {
      const inHead = head.includes(t);
      const n = countOf(def, t, 20);
      if (!inHead && n === 0) { ok = false; break; }
      s += (inHead ? 1000 : 0) + n;
    }
    if (ok) hits.push({ e, s });
  }
  hits.sort((a, b) => b.s - a.s || a.e.i - b.e.i);
  return hits.map((h) => h.e);
}

function countOf(text, t, cap) {
  let n = 0;
  let i = text.indexOf(t);
  while (i !== -1 && n < cap) { n++; i = text.indexOf(t, i + t.length); }
  return n;
}

let searchSeq = 0;

async function runSearch({ push = false } = {}) {
  const opt = getOptions();
  const seq = ++searchSeq;
  state.mode = opt.mode;
  state.entryView = false;
  syncUrl(opt, push);
  state.entries.forEach((e) => { e._fuzzy = false; });

  if (!opt.q) {
    state.results = [];
    state.matcher = null;
    $('intro').hidden = false;
    $('results').innerHTML = '';
    $('more-wrap').hidden = true;
    updateStatus();
    return;
  }
  $('intro').hidden = true;

  const terms = splitTerms(opt.q);
  state.matcher = termMatcher(terms);

  if (opt.mode === 'full') {
    if (!state.defs) {
      setStatus('語釈データを読み込み中…');
      await state.defsPromise;
      if (seq !== searchSeq) return;
    }
    state.results = searchFull(opt, terms);
  } else {
    state.results = searchHead(opt, terms);
  }

  state.shown = 0;
  $('results').innerHTML = '';
  renderMore();
  updateStatus();
}

// ---------------------------------------------------------------- 表示

function renderMore() {
  const next = state.results.slice(state.shown, state.shown + PAGE_SIZE);
  $('results').insertAdjacentHTML('beforeend', next.map((e) => renderEntry(e)).join(''));
  state.shown += next.length;
  const rest = state.results.length - state.shown;
  $('more-wrap').hidden = rest <= 0;
  $('more').textContent = `さらに表示（残り ${rest.toLocaleString()} 件）`;
}

// 辞書名の表記（検索結果のバッジと絞り込みのチェックボックスで共通）
function dictLabel(d) {
  return `『${esc(d.short)}』(${d.year})`;
}

function renderEntry(e, { focus = false } = {}) {
  const d = state.dicts[e.d];
  const parts = [];

  // 司法省日誌の記事カードと同じく、上段に項目id（塗り）と属性バッジ（枠線）、右端に原本リンク
  parts.push('<div class="entry-meta">');
  parts.push(`<a class="badge badge-solid" href="?id=${encodeURIComponent(e.id)}" data-id="${esc(e.id)}" title="この項目へのリンク">${esc(e.id)}</a>`);
  parts.push(`<span class="badge">${dictLabel(d)}</span>`);
  if (e.p) parts.push(e.p.map((p) => `<span class="badge">${esc(POS_LABEL[p] || p)}</span>`).join(''));
  if (e._fuzzy) parts.push('<span class="badge">綴りの近い語</span>');
  parts.push(`<a class="source" href="${esc(e.u)}" target="_blank" rel="noopener">原本 →</a>`);
  parts.push('</div>');

  parts.push('<div class="hw-line">');
  parts.push(`<h2 class="hw" lang="${esc(e.hl)}">${e.h.map(hl).join(' ／ ')}</h2>`);
  if (e.c) parts.push(`<span class="col">${esc(e.c)}</span>`);
  if (e.r) parts.push(`<span class="reading">（${e.r.map(hl).join('・')}）</span>`);
  parts.push('</div>');

  // 対訳は見出しの下に置く。原本で語釈の末尾にある辞書（transAfter）は語釈の後ろに置く
  const trans = [];
  if (e.t) {
    const byLang = new Map();
    for (const [lang, s] of e.t) {
      if (!byLang.has(lang)) byLang.set(lang, []);
      byLang.get(lang).push(s);
    }
    trans.push('<dl class="trans">');
    for (const [lang, list] of byLang) {
      trans.push(`<div><dt>${esc(LANG_LABEL[lang] || lang)}</dt><dd lang="${esc(lang)}">${list.map(hl).join('、')}</dd></div>`);
    }
    trans.push('</dl>');
  }

  if (!d.transAfter) parts.push(...trans);
  if (e.df) parts.push(`<div class="def" data-id="${esc(e.id)}">${renderDef(e, focus)}</div>`);
  if (d.transAfter) parts.push(...trans);

  if (e.rel) {
    const links = e.rel
      .map((id) => state.byId.get(id))
      .filter(Boolean)
      .map((r) => `<a href="?id=${encodeURIComponent(r.id)}" data-id="${esc(r.id)}">${esc(r.h[0])}</a>`);
    if (links.length) parts.push(`<div class="rel"><span class="rel-caption">関連:</span> ${links.join('')}</div>`);
  }

  return `<article class="entry${focus ? ' focus' : ''}">${parts.join('')}</article>`;
}

function renderDef(e, full) {
  if (!state.defs) return '<span class="note">語釈を読み込み中…</span>';
  const text = state.defs[e.id] || '';
  if (full || text.length <= PREVIEW_CHARS) return hl(text);

  // 全文検索では一致箇所の前後を、見出し検索では冒頭を示す
  if (state.mode === 'full' && state.matcher) {
    const ranges = mergeRanges(state.matcher(norm(text)));
    if (ranges.length) {
      // 一致箇所の前後の窓を作る。重なる窓はまとめるが、長くなりすぎる場合は重ならないよう切り詰める
      const windows = [];
      for (const [s, en] of ranges) {
        let from = Math.max(0, s - KWIC_CHARS);
        const to = Math.min(text.length, en + KWIC_CHARS);
        const last = windows[windows.length - 1];
        if (last && from <= last.to) {
          if (to - last.from <= KWIC_CHARS * 4) { last.to = Math.max(last.to, to); continue; }
          if (s < last.to) continue;   // この一致は前の窓に含まれている
          from = last.to;
        }
        windows.push({ from, to });
      }
      const snippets = windows.slice(0, KWIC_MAX).map(({ from, to }) => {
        const local = ranges
          .filter(([a, b]) => a >= from && b <= to)
          .map(([a, b]) => [a - from, b - from]);
        return `<span class="kwic">${highlight(text.slice(from, to), local)}</span>`;
      });
      const more = windows.length > KWIC_MAX ? `<span class="note">ほか ${windows.length - KWIC_MAX} 箇所</span>` : '';
      return snippets.join('') + more + '<button class="toggle" type="button">全文を表示</button>';
    }
  }
  return hl(text.slice(0, PREVIEW_CHARS)) + '…<button class="toggle" type="button">全文を表示</button>';
}

function showEntry(id, { push = false } = {}) {
  const e = state.byId.get(id);
  if (!e) { setStatus(`項目 ${id} が見つかりません`, true); return; }
  ++searchSeq;
  state.matcher = null;
  state.mode = 'head';
  state.entryView = true;
  state.results = [];
  $('intro').hidden = true;
  $('more-wrap').hidden = true;
  const url = new URL(location.href);
  url.search = `?id=${encodeURIComponent(id)}`;
  history[push ? 'pushState' : 'replaceState'](null, '', url);

  const render = () => {
    const related = (e.rel || []).map((r) => state.byId.get(r)).filter(Boolean);
    $('results').innerHTML = renderEntry(e, { focus: true }) + related.map((r) => renderEntry(r)).join('');
  };
  render();
  if (!state.defs) state.defsPromise.then(render);
  setStatus(`${state.dicts[e.d].short}「${e.h[0]}」`);
  window.scrollTo({ top: 0 });
}

function setStatus(text, error = false) {
  $('status').textContent = text;
  $('status').classList.toggle('error', error);
}

function updateStatus() {
  if (state.entryView) return;
  const defsNote = state.defs ? '' : '（語釈を読み込み中）';
  if (!$('q').value.trim()) {
    setStatus(`${state.entries.length.toLocaleString()} 項目${defsNote}`);
    return;
  }
  const byDict = state.dicts.map((d, i) => {
    const n = state.results.filter((e) => e.d === i).length;
    return n ? `${d.short} ${n.toLocaleString()}` : null;
  }).filter(Boolean);
  setStatus(`${state.results.length.toLocaleString()} 件${byDict.length ? `（${byDict.join('・')}）` : ''}${defsNote}`);
}

function showError(err) {
  setStatus(`読み込みに失敗しました: ${err.message}`, true);
}

// ---------------------------------------------------------------- URL

function syncUrl(opt, push) {
  const p = new URLSearchParams();
  if (opt.q) p.set('q', opt.q);
  if (opt.mode !== 'head') p.set('m', opt.mode);
  if (opt.dicts.size !== state.dicts.length) p.set('d', [...opt.dicts].join(','));
  const url = new URL(location.href);
  url.search = p.toString() ? `?${p}` : '';
  if (url.href !== location.href) history[push ? 'pushState' : 'replaceState'](null, '', url);
}

function applyUrl() {
  const p = new URLSearchParams(location.search);
  if (p.has('id')) {
    showEntry(p.get('id'));
    return;
  }
  $('q').value = p.get('q') || '';
  const mode = p.get('m') === 'full' ? 'full' : 'head';
  document.querySelector(`input[name=mode][value=${mode}]`).checked = true;
  const d = p.get('d');
  const included = d ? new Set(d.split(',').map(Number)) : null;
  document.querySelectorAll('#dict-filter input').forEach((x) => {
    x.checked = !included || included.has(Number(x.value));
  });
  runSearch();
}

// ---------------------------------------------------------------- 初期化

function buildDictUi() {
  $('dict-filter').innerHTML = state.dicts.map((d, i) =>
    `<label><input type="checkbox" value="${i}" checked> ${dictLabel(d)}</label>`).join('');
  $('dict-list').innerHTML = state.dicts.map((d) =>
    `<tr><td class="muted-cell">${d.year}</td>`
    + `<td><a href="docs/${encodeURIComponent(d.id)}.html">${esc(d.title)}</a></td>`
    + `<td class="muted-cell">${esc(d.dir)}</td>`
    + `<td class="muted-cell">${esc(d.status || '')}</td>`
    + `<td class="num-cell">${d.count.toLocaleString()}</td></tr>`).join('');
}

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

function bindEvents() {
  const debounced = debounce(() => runSearch(), 300);
  $('q').addEventListener('input', debounced);
  $('q').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') runSearch({ push: true });
  });
  $('clear').addEventListener('click', () => {
    $('q').value = '';
    runSearch({ push: true });
    $('q').focus();
  });
  document.querySelectorAll('input[name=mode]').forEach((x) => x.addEventListener('change', () => runSearch()));
  $('dict-filter').addEventListener('change', () => runSearch());
  $('more').addEventListener('click', renderMore);

  $('results').addEventListener('click', (ev) => {
    const toggle = ev.target.closest('.toggle');
    if (toggle) {
      const box = toggle.closest('.def');
      box.innerHTML = renderDef(state.byId.get(box.dataset.id), true);
      return;
    }
    const link = ev.target.closest('a[data-id]');
    if (link && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey) {
      ev.preventDefault();
      showEntry(link.dataset.id, { push: true });
    }
  });

  window.addEventListener('popstate', applyUrl);
}

(async () => {
  try {
    await load();
  } catch (err) {
    showError(err);
    return;
  }
  buildDictUi();
  bindEvents();
  applyUrl();
  // 語釈が後から届いたら、表示中の「読み込み中」を差し替える
  state.defsPromise.then(() => {
    document.querySelectorAll('.def[data-id]').forEach((box) => {
      box.innerHTML = renderDef(state.byId.get(box.dataset.id), !!box.closest('.entry.focus'));
    });
  }).catch(() => {});
})();
