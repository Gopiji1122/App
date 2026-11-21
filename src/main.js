import './polyfill.js';
import './style.css';
import LightningFS from '@isomorphic-git/lightning-fs';
import git from 'isomorphic-git';
import http from 'isomorphic-git/http/web';
import JSZip from 'jszip';
import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { EditorView, basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { indentWithTab, indentMore, undo, redo } from '@codemirror/commands';
import { openSearchPanel } from '@codemirror/search';
import { javascript } from '@codemirror/lang-javascript';
import { html as htmlLang } from '@codemirror/lang-html';
import { css as cssLang } from '@codemirror/lang-css';
import { json as jsonLang } from '@codemirror/lang-json';
import { markdown as mdLang } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { oneDark } from '@codemirror/theme-one-dark';

/* ---------- helpers & settings ---------- */
const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dirname = p => p.substring(0, p.lastIndexOf('/'));
const basename = p => p.substring(p.lastIndexOf('/') + 1);
const BIN = /\.(png|jpe?g|gif|webp|ico|zip|pdf|woff2?|ttf|otf|mp[34]|apk|jar)$/i;

const DEF = { fontSize: 14, wrap: true, theme: 'dark', autosave: true, name: '', email: '', user: '', token: '', proxy: 'https://cors.isomorphic-git.org' };
let cfg = { ...DEF, ...JSON.parse(localStorage.getItem('cd.cfg') || '{}') };
const saveCfg = () => localStorage.setItem('cd.cfg', JSON.stringify(cfg));
document.body.dataset.theme = cfg.theme;

let tt;
function toast(m) {
  const t = $('#toast'); t.textContent = m; t.classList.add('on');
  clearTimeout(tt); tt = setTimeout(() => t.classList.remove('on'), 2400);
}

function modal(title, body, opts = {}) {
  const m = document.createElement('div');
  m.className = 'modal';
  m.innerHTML = `<div class="mbox ${opts.full ? 'full' : ''}"><div class="mh"><span>${esc(title)}</span><button class="x">✕</button></div><div class="mb"></div></div>`;
  const mb = m.querySelector('.mb');
  if (typeof body === 'string') mb.innerHTML = body; else mb.append(body);
  function close() { m.remove(); if (opts.onClose) opts.onClose(); }
  m.querySelector('.x').onclick = close;
  document.body.append(m);
  return { el: mb, close };
}
function sheet(title, items) {
  const b = document.createElement('div'); b.className = 'sheet';
  const g = modal(title, b);
  for (const [label, fn] of items) {
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.onclick = () => { g.close(); fn(); };
    b.append(btn);
  }
}

/* ---------- filesystem ---------- */
const lfs = new LightningFS('codedroid');
const pfs = lfs.promises;
const S = { project: localStorage.getItem('cd.project') || 'my-project', open: [], active: null, docs: new Map(), expanded: new Set(), logs: [], switching: false };
const root = () => '/p/' + S.project;

async function ensureDir(p) {
  let cur = '';
  for (const x of p.split('/').filter(Boolean)) {
    cur += '/' + x;
    try { await pfs.mkdir(cur); } catch (e) { /* exists */ }
  }
}
async function listDir(dir) {
  const out = [];
  for (const n of await pfs.readdir(dir)) {
    if (n === '.git') continue;
    const p = dir + '/' + n;
    const st = await pfs.stat(p);
    out.push({ name: n, path: p, dir: st.isDirectory() });
  }
  return out.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
}
async function rmrf(p) {
  const st = await pfs.stat(p);
  if (st.isDirectory()) {
    for (const n of await pfs.readdir(p)) await rmrf(p + '/' + n);
    await pfs.rmdir(p);
  } else await pfs.unlink(p);
}
async function walk(dir, cb) {
  for (const e of await listDir(dir)) {
    if (e.dir) await walk(e.path, cb); else await cb(e.path);
  }
}

/* ---------- editor ---------- */
const langFor = p => {
  const e = p.split('.').pop().toLowerCase();
  if (['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx'].includes(e)) return javascript({ jsx: true, typescript: /^tsx?$/.test(e) });
  if (['html', 'htm', 'svg', 'xml', 'vue'].includes(e)) return htmlLang();
  if (e === 'css') return cssLang();
  if (e === 'json') return jsonLang();
  if (['md', 'markdown'].includes(e)) return mdLang();
  if (e === 'py') return python();
  return [];
};

function mkState(path, text) {
  return EditorState.create({
    doc: text,
    extensions: [
      basicSetup, langFor(path),
      cfg.theme === 'dark' ? oneDark : [],
      cfg.wrap ? EditorView.lineWrapping : [],
      EditorView.theme({ '&': { fontSize: cfg.fontSize + 'px' }, '.cm-scroller': { fontFamily: 'ui-monospace,Menlo,monospace' } }),
      keymap.of([indentWithTab, { key: 'Mod-s', run: () => { saveActive(); return true; } }]),
      EditorView.updateListener.of(u => { if (u.docChanged && !S.switching && S.active === path) markDirty(path); })
    ]
  });
}
const view = new EditorView({ state: EditorState.create({ doc: '' }), parent: $('#editor') });

const getText = p => (p === S.active ? view.state.doc.toString() : S.docs.get(p).state.doc.toString());

function markDirty(p) {
  const d = S.docs.get(p); if (!d) return;
  if (!d.dirty) { d.dirty = true; renderTabs(); }
  if (cfg.autosave) { clearTimeout(d.t); d.t = setTimeout(() => save(p), 1200); }
}
async function save(p) {
  const d = S.docs.get(p); if (!d) return;
  await pfs.writeFile(p, getText(p), 'utf8');
  d.dirty = false; renderTabs();
}
async function saveActive() { if (S.active) { await save(S.active); toast('Saved'); } }
async function saveAll() { for (const p of S.open) if (S.docs.get(p).dirty) await save(p); }

function renderTabs() {
  $('#tabs').innerHTML = S.open.map(p => `<div class="tab ${p === S.active ? 'on' : ''}" data-p="${esc(p)}">${esc(basename(p))}${S.docs.get(p).dirty ? ' •' : ''}<b data-x="1">×</b></div>`).join('');
  $('#empty').style.display = S.open.length ? 'none' : 'flex';
  const on = $('#tabs .on'); if (on) on.scrollIntoView({ inline: 'nearest', block: 'nearest' });
}
function activate(p) {
  if (S.active && S.docs.has(S.active)) S.docs.get(S.active).state = view.state;
  S.active = p;
  S.switching = true; view.setState(S.docs.get(p).state); S.switching = false;
  renderTabs();
}
async function openFile(p) {
  if (!S.docs.has(p)) {
    if (BIN.test(p)) return toast('Binary files cannot be edited');
    const text = await pfs.readFile(p, 'utf8');
    S.docs.set(p, { state: mkState(p, text), dirty: false });
    S.open.push(p);
  }
  activate(p); closeSidebar();
}
async function closeTab(p) {
  const d = S.docs.get(p); if (!d) return;
  if (d.dirty) await save(p);
  const i = S.open.indexOf(p);
  S.open.splice(i, 1); S.docs.delete(p);
  if (S.active === p) {
    S.active = null;
    const n = S.open[Math.min(i, S.open.length - 1)];
    if (n) activate(n);
    else { S.switching = true; view.setState(EditorState.create({ doc: '' })); S.switching = false; renderTabs(); }
  } else renderTabs();
}
async function dropTabs(p, keep = true) {
  for (const q of [...S.open]) {
    if (q === p || q.startsWith(p + '/')) { if (!keep) S.docs.get(q).dirty = false; await closeTab(q); }
  }
}
function rebuildStates() {
  for (const p of S.open) {
    const text = getText(p);
    const st = mkState(p, text);
    S.docs.get(p).state = st;
    if (p === S.active) { S.switching = true; view.setState(st); S.switching = false; }
  }
}

$('#tabs').addEventListener('click', e => {
  const t = e.target.closest('.tab'); if (!t) return;
  if (e.target.dataset.x) closeTab(t.dataset.p); else activate(t.dataset.p);
});

/* ---------- sidebar / tree ---------- */
const closeSidebar = () => { $('#side').classList.remove('on'); $('#scrim').classList.remove('on'); };
$('#bMenuSide').onclick = () => { $('#side').classList.toggle('on'); $('#scrim').classList.toggle('on'); };
$('#scrim').onclick = closeSidebar;

async function treeHtml(dir, depth) {
  let h = '';
  for (const e of await listDir(dir)) {
    const open = S.expanded.has(e.path);
    h += `<div class="row" data-path="${esc(e.path)}" data-dir="${e.dir ? 1 : 0}" style="padding-left:${8 + depth * 14}px"><span class="ic">${e.dir ? (open ? '▾' : '▸') : '·'}</span><span class="nm">${esc(e.name)}</span><button class="more" data-more="1">⋮</button></div>`;
    if (e.dir && open) h += await treeHtml(e.path, depth + 1);
  }
  return h;
}
async function refreshTree() {
  $('#pname').textContent = '📂 ' + S.project;
  $('#tree').innerHTML = (await treeHtml(root(), 0)) || '<div class="muted" style="padding:14px">Empty project</div>';
}
$('#tree').addEventListener('click', e => {
  const row = e.target.closest('.row'); if (!row) return;
  const p = row.dataset.path, isDir = row.dataset.dir === '1';
  if (e.target.dataset.more) return fileSheet(p, isDir);
  if (isDir) { S.expanded.has(p) ? S.expanded.delete(p) : S.expanded.add(p); refreshTree(); }
  else openFile(p).catch(err => toast(err.message));
});

async function newFile(dir) {
  const n = prompt('File name (e.g. app.js or src/app.js)'); if (!n) return;
  const p = dir + '/' + n.replace(/^\/+/, '');
  try {
    await ensureDir(dirname(p)); await pfs.writeFile(p, '', 'utf8');
    S.expanded.add(dir); await refreshTree(); await openFile(p);
  } catch (e) { toast(e.message); }
}
async function newFolder(dir) {
  const n = prompt('Folder name'); if (!n) return;
  await ensureDir(dir + '/' + n); S.expanded.add(dir); refreshTree();
}
async function renameItem(p) {
  const n = prompt('New name', basename(p)); if (!n || n === basename(p)) return;
  await dropTabs(p, true);
  try { await pfs.rename(p, dirname(p) + '/' + n); } catch (e) { toast(e.message); }
  refreshTree();
}
async function deleteItem(p) {
  if (!confirm('Delete ' + basename(p) + '?')) return;
  await dropTabs(p, false); await rmrf(p); refreshTree();
}
function fileSheet(p, isDir) {
  const items = [];
  if (isDir) items.push(['New file here', () => newFile(p)], ['New folder here', () => newFolder(p)]);
  items.push(['Rename', () => renameItem(p)], ['Delete', () => deleteItem(p)]);
  sheet(basename(p), items);
}
$('#bNewF').onclick = () => newFile(root());
$('#bNewD').onclick = () => newFolder(root());

/* ---------- projects ---------- */
async function createSample(name) {
  const d = '/p/' + name;
  await ensureDir(d);
  await pfs.writeFile(d + '/index.html', '<!DOCTYPE html>\n<html>\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width,initial-scale=1">\n  <title>Hello</title>\n  <link rel="stylesheet" href="style.css">\n</head>\n<body>\n  <h1>Hello, CodeDroid!</h1>\n  <button id="b">Click me</button>\n  <script src="script.js"></script>\n</body>\n</html>\n', 'utf8');
  await pfs.writeFile(d + '/style.css', 'body { font-family: sans-serif; padding: 20px; }\nh1 { color: #3b82f6; }\n', 'utf8');
  await pfs.writeFile(d + '/script.js', "document.getElementById('b').onclick = () => console.log('clicked!', new Date());\nconsole.log('ready');\n", 'utf8');
}
async function switchProject(n) {
  await saveAll(); await dropTabs(root(), true);
  S.project = n; localStorage.setItem('cd.project', n); S.expanded.clear();
  await refreshTree();
}
async function projectsPanel() {
  const names = await pfs.readdir('/p');
  const b = document.createElement('div');
  b.innerHTML = names.map(n => `<div class="row" data-n="${esc(n)}"><span class="nm">${n === S.project ? '● ' : ''}${esc(n)}</span><button data-del="1">🗑</button></div>`).join('') +
    '<div class="btns"><button id="npj">＋ New project</button><button id="cln">⤓ Clone repo</button></div>';
  const g = modal('Projects', b);
  b.onclick = async e => {
    if (e.target.id === 'npj') {
      const n = (prompt('Project name') || '').replace(/[^\w.-]/g, ''); if (!n) return;
      g.close(); await createSample(n); await switchProject(n);
    } else if (e.target.id === 'cln') { g.close(); cloneRepo(); }
    else {
      const row = e.target.closest('.row'); if (!row) return;
      const n = row.dataset.n;
      if (e.target.dataset.del) {
        if (!confirm('Delete project ' + n + '?')) return;
        if (n === S.project) { await dropTabs(root(), false); }
        await rmrf('/p/' + n);
        const left = await pfs.readdir('/p');
        if (!left.length) await createSample('my-project');
        g.close();
        if (n === S.project) await switchProject((await pfs.readdir('/p'))[0]); else projectsPanel();
      } else { g.close(); switchProject(n); }
    }
  };
}
$('#pname').onclick = projectsPanel;

/* ---------- search in files ---------- */
function searchPanel() {
  const b = document.createElement('div');
  b.innerHTML = '<div class="cin"><input id="sq" placeholder="Search in project"><button id="sgo">Go</button></div><div id="sres"></div>';
  const g = modal('Search in files', b, { full: true });
  const go = async () => {
    const q = b.querySelector('#sq').value.toLowerCase(); if (!q) return;
    const res = b.querySelector('#sres'); res.textContent = 'Searching…';
    let out = '', n = 0;
    await walk(root(), async p => {
      if (n >= 200 || BIN.test(p)) return;
      let t; try { t = await pfs.readFile(p, 'utf8'); } catch (e) { return; }
      if (t.length > 5e5) return;
      t.split('\n').forEach((ln, i) => {
        if (n < 200 && ln.toLowerCase().includes(q)) {
          n++; out += `<div class="hit" data-p="${esc(p)}" data-l="${i + 1}"><b>${esc(p.slice(root().length + 1))}:${i + 1}</b><br>${esc(ln.trim().slice(0, 120))}</div>`;
        }
      });
    });
    res.innerHTML = out || '<div class="muted">No results</div>';
  };
  b.querySelector('#sgo').onclick = go;
  b.querySelector('#sq').onkeydown = e => { if (e.key === 'Enter') go(); };
  b.onclick = async e => {
    const h = e.target.closest('.hit'); if (!h) return;
    g.close(); await openFile(h.dataset.p);
    const ln = view.state.doc.line(Math.min(+h.dataset.l, view.state.doc.lines));
    view.dispatch({ selection: { anchor: ln.from }, scrollIntoView: true }); view.focus();
  };
}

/* ---------- live preview + console ---------- */
const HOOK = `<script>(function(){var send=function(t,a){parent.postMessage({__cd:1,t:t,a:a.map(function(x){try{return typeof x==='object'?JSON.stringify(x):String(x)}catch(e){return String(x)}})},'*')};['log','warn','error','info'].forEach(function(k){var o=console[k];console[k]=function(){var a=[].slice.call(arguments);send(k,a);o.apply(console,a)}});addEventListener('error',function(e){send('error',[e.message+' (line '+(e.lineno||0)+')'])});addEventListener('unhandledrejection',function(e){send('error',[String(e.reason)])});addEventListener('message',function(e){if(e.data&&e.data.__eval){try{var r=(0,eval)(e.data.__eval);send('log',['\u2190',r])}catch(err){send('error',[String(err)])}}})})()<\/script>`;

async function replaceAsync(str, re, fn) {
  const jobs = []; str.replace(re, (...a) => { jobs.push(fn(...a)); return ''; });
  const res = await Promise.all(jobs); let i = 0;
  return str.replace(re, () => res[i++]);
}
async function buildPreview() {
  const entry = S.active && /\.html?$/i.test(S.active) ? S.active : root() + '/index.html';
  let src = await pfs.readFile(entry, 'utf8');
  const base = dirname(entry);
  const resolve = href => {
    if (/^([a-z]+:|\/\/)/i.test(href)) return null;
    const parts = (href.startsWith('/') ? root() + href : base + '/' + href.split(/[?#]/)[0]).split('/');
    const out = [];
    for (const x of parts) { if (x === '.' || x === '') continue; if (x === '..') out.pop(); else out.push(x); }
    return '/' + out.join('/');
  };
  src = await replaceAsync(src, /<link[^>]*href=["']([^"']+)["'][^>]*>/gi, async (m, href) => {
    if (!/stylesheet/i.test(m)) return m;
    const p = resolve(href); if (!p) return m;
    try { return `<style>${await pfs.readFile(p, 'utf8')}</style>`; } catch (e) { return m; }
  });
  src = await replaceAsync(src, /<script([^>]*?)src=["']([^"']+)["']([^>]*)><\/script>/gi, async (m, a, s, b) => {
    const p = resolve(s); if (!p) return m;
    try { return `<script${a}${b}>${(await pfs.readFile(p, 'utf8')).replace(/<\/script>/gi, '<\\/script>')}<\/script>`; } catch (e) { return m; }
  });
  return HOOK + src;
}
function appendLog(el, d) {
  const l = document.createElement('div'); l.className = d.t; l.textContent = d.a.join(' ');
  el.append(l); el.scrollTop = el.scrollHeight;
}
window.addEventListener('message', e => {
  const d = e.data; if (!d || !d.__cd) return;
  S.logs.push(d); const el = $('#clog'); if (el) appendLog(el, d);
});
async function preview() {
  await saveAll();
  let doc;
  try { doc = await buildPreview(); } catch (e) { return toast('Preview failed: ' + (e.message || e)); }
  S.logs = [];
  const w = document.createElement('div'); w.className = 'pv';
  w.innerHTML = '<iframe sandbox="allow-scripts allow-modals allow-forms allow-popups"></iframe><div class="con"><div id="clog"></div><div class="cin"><input id="ceval" placeholder="Run JS in page…" autocapitalize="off" autocorrect="off" spellcheck="false"><button id="cgo">▶</button><button id="cclr">⌫</button></div></div>';
  modal('Live preview & console', w, { full: true });
  const fr = w.querySelector('iframe'); fr.srcdoc = doc;
  const run = () => { const i = w.querySelector('#ceval'); if (!i.value) return; fr.contentWindow.postMessage({ __eval: i.value }, '*'); i.value = ''; };
  w.querySelector('#cgo').onclick = run;
  w.querySelector('#ceval').onkeydown = e => { if (e.key === 'Enter') run(); };
  w.querySelector('#cclr').onclick = () => { S.logs = []; w.querySelector('#clog').innerHTML = ''; };
}

/* ---------- git ---------- */
const gitBase = () => ({ fs: lfs, dir: root() });
const gitNet = () => ({
  ...gitBase(), http, corsProxy: cfg.proxy || undefined,
  onAuth: () => ({ username: cfg.user || 'token', password: cfg.token }),
  author: { name: cfg.name || 'CodeDroid', email: cfg.email || 'user@codedroid.app' }
});
async function cloneRepo() {
  const url = prompt('Repository URL (https://github.com/user/repo)'); if (!url) return;
  const name = url.replace(/\/$/, '').split('/').pop().replace(/\.git$/, '').replace(/[^\w.-]/g, '') || 'repo';
  const dir = '/p/' + name;
  try {
    await ensureDir(dir); toast('Cloning…');
    await git.clone({ fs: lfs, http, dir, url, corsProxy: cfg.proxy || undefined, singleBranch: true,
      onAuth: () => ({ username: cfg.user || 'token', password: cfg.token }),
      onProgress: p => toast('Clone: ' + p.phase + (p.total ? ' ' + Math.round(p.loaded / p.total * 100) + '%' : '')) });
    await switchProject(name); toast('Cloned ' + name);
  } catch (e) { toast('Clone failed: ' + (e.message || e)); }
}
async function gitPanel() {
  const w = document.createElement('div');
  const g = modal('Git', w, { full: true });
  const run = async (label, fn) => {
    toast(label + '…');
    try { await fn(); toast(label + ' done'); } catch (e) { toast(label + ' failed: ' + (e.message || e)); }
    await render(); refreshTree();
  };
  async function render() {
    let isRepo = true;
    try { await pfs.stat(root() + '/.git'); } catch (e) { isRepo = false; }
    if (!isRepo) {
      w.innerHTML = '<p class="muted">This project is not a Git repository.</p><div class="btns"><button data-a="init">Init repository</button><button data-a="clone">Clone repo</button></div>';
      return;
    }
    const o = gitBase(); let branch = '?', remotes = [], rows = [];
    try { branch = (await git.currentBranch(o)) || '(detached)'; } catch (e) { /* no commits */ }
    try { remotes = await git.listRemotes(o); } catch (e) { /* none */ }
    try { rows = await git.statusMatrix(o); } catch (e) { /* none */ }
    const ch = rows.filter(r => !(r[1] === 1 && r[2] === 1 && r[3] === 1));
    const lab = r => (r[1] === 0 ? 'A' : r[2] === 0 ? 'D' : 'M');
    w.innerHTML = `<div><b>Branch:</b> ${esc(branch)}</div><div class="muted" style="word-break:break-all">${remotes.length ? esc(remotes[0].url) : 'No remote set'}</div>
      <div style="margin:10px 0"><b>Changes (${ch.length})</b>${ch.map(r => `<div class="st">${lab(r)}  ${esc(r[0])}</div>`).join('') || '<div class="muted">Working tree clean</div>'}</div>
      <textarea id="cmsg" rows="2" placeholder="Commit message"></textarea>
      <div class="btns"><button data-a="commit">Stage all + Commit</button><button data-a="push">Push</button><button data-a="pull">Pull</button><button data-a="branches">Branches</button><button data-a="log">History</button><button data-a="remote">Set remote</button></div>`;
  }
  w.onclick = async e => {
    const a = e.target.dataset.a; if (!a) return;
    const o = gitNet();
    if (a === 'init') return run('Init', async () => { await git.init({ ...gitBase(), defaultBranch: 'main' }); });
    if (a === 'clone') { g.close(); return cloneRepo(); }
    if (a === 'remote') {
      const url = prompt('Remote URL (origin)'); if (!url) return;
      return run('Set remote', async () => { await git.addRemote({ ...gitBase(), remote: 'origin', url, force: true }); });
    }
    if (a === 'commit') {
      const msg = w.querySelector('#cmsg').value.trim(); if (!msg) return toast('Enter a commit message');
      await saveAll();
      return run('Commit', async () => {
        for (const r of await git.statusMatrix(gitBase())) {
          if (r[1] === 1 && r[2] === 1 && r[3] === 1) continue;
          if (r[2] === 0) await git.remove({ ...gitBase(), filepath: r[0] }); else await git.add({ ...gitBase(), filepath: r[0] });
        }
        await git.commit({ ...gitBase(), message: msg, author: o.author });
      });
    }
    if (a === 'push') return run('Push', async () => { await git.push({ ...o, remote: 'origin', ref: await git.currentBranch(o) }); });
    if (a === 'pull') return run('Pull', async () => {
      await saveAll(); await dropTabs(root(), true);
      await git.pull({ ...o, remote: 'origin', ref: await git.currentBranch(o), singleBranch: true });
    });
    if (a === 'log') {
      const list = await git.log({ ...gitBase(), depth: 25 }).catch(() => []);
      const b = document.createElement('div');
      b.innerHTML = list.map(c => `<div class="hit"><b>${c.oid.slice(0, 7)}</b> ${esc(c.commit.message.split('\n')[0])}<br><span class="muted">${esc(c.commit.author.name)} · ${new Date(c.commit.author.timestamp * 1000).toLocaleString()}</span></div>`).join('') || '<div class="muted">No commits</div>';
      modal('History', b);
    }
    if (a === 'branches') {
      const o2 = gitBase(); const cur = await git.currentBranch(o2).catch(() => ''); const list = await git.listBranches(o2).catch(() => []);
      const b = document.createElement('div');
      b.innerHTML = list.map(n => `<div class="hit" data-b="${esc(n)}">${n === cur ? '● ' : ''}${esc(n)}</div>`).join('') + '<div class="btns"><button id="nb">＋ New branch</button></div>';
      const bm = modal('Branches', b);
      b.onclick = async ev => {
        let ref = ev.target.closest('.hit')?.dataset.b, create = false;
        if (ev.target.id === 'nb') { ref = prompt('New branch name'); create = true; }
        if (!ref) return;
        bm.close();
        run('Checkout', async () => {
          await saveAll(); await dropTabs(root(), true);
          if (create) await git.branch({ ...o2, ref, checkout: true }); else await git.checkout({ ...o2, ref });
        });
      };
    }
  };
  render();
}

/* ---------- import / export / settings ---------- */
async function exportZip() {
  await saveAll();
  const zip = new JSZip();
  await walk(root(), async p => { zip.file(p.slice(root().length + 1), await pfs.readFile(p)); });
  const b64 = await zip.generateAsync({ type: 'base64' }); const name = S.project + '.zip';
  if (Capacitor.isNativePlatform()) {
    const r = await Filesystem.writeFile({ path: name, data: b64, directory: Directory.Cache });
    await Share.share({ title: name, url: r.uri });
  } else {
    const a = document.createElement('a'); a.href = 'data:application/zip;base64,' + b64; a.download = name; a.click();
  }
}
$('#imp').onchange = async e => {
  try {
    for (const f of e.target.files) {
      if (/\.zip$/i.test(f.name)) {
        const z = await JSZip.loadAsync(f);
        for (const [n, ent] of Object.entries(z.files)) {
          if (ent.dir || n.includes('..')) continue;
          const p = root() + '/' + n; await ensureDir(dirname(p));
          await pfs.writeFile(p, await ent.async('uint8array'));
        }
      } else await pfs.writeFile(root() + '/' + f.name, new Uint8Array(await f.arrayBuffer()));
    }
    toast('Imported'); refreshTree();
  } catch (err) { toast('Import failed: ' + err.message); }
  e.target.value = '';
};
function settingsPanel() {
  const w = document.createElement('div');
  w.innerHTML = `<label>Font size</label><input id="s_fs" type="number" min="9" max="28" value="${cfg.fontSize}">
    <label>Theme</label><select id="s_th"><option value="dark">Dark</option><option value="light">Light</option></select>
    <label><input id="s_wr" type="checkbox" style="width:auto" ${cfg.wrap ? 'checked' : ''}> Word wrap</label><br>
    <label><input id="s_as" type="checkbox" style="width:auto" ${cfg.autosave ? 'checked' : ''}> Autosave</label>
    <hr><b>Git</b><br><label>Author name</label><input id="s_nm" value="${esc(cfg.name)}">
    <label>Author email</label><input id="s_em" value="${esc(cfg.email)}">
    <label>Username (optional)</label><input id="s_us" value="${esc(cfg.user)}">
    <label>Access token (GitHub PAT)</label><input id="s_tk" type="password" value="${esc(cfg.token)}">
    <label>CORS proxy</label><input id="s_px" value="${esc(cfg.proxy)}">
    <div class="btns"><button id="s_ok">Save settings</button></div>`;
  const g = modal('Settings', w, { full: true });
  w.querySelector('#s_th').value = cfg.theme;
  w.querySelector('#s_ok').onclick = () => {
    const v = id => w.querySelector(id);
    cfg = { fontSize: +v('#s_fs').value || 14, theme: v('#s_th').value, wrap: v('#s_wr').checked, autosave: v('#s_as').checked,
      name: v('#s_nm').value, email: v('#s_em').value, user: v('#s_us').value, token: v('#s_tk').value, proxy: v('#s_px').value };
    saveCfg(); document.body.dataset.theme = cfg.theme; rebuildStates(); g.close(); toast('Settings saved');
  };
}

/* ---------- toolbar / keys / menu ---------- */
$('#bUndo').onclick = () => { undo(view); view.focus(); };
$('#bRedo').onclick = () => { redo(view); view.focus(); };
$('#bFind').onclick = () => { openSearchPanel(view); };
$('#bSave').onclick = saveActive;
$('#bRun').onclick = preview;
$('#bMore').onclick = () => sheet('Menu', [
  ['New file', () => newFile(root())], ['New folder', () => newFolder(root())],
  ['Projects', projectsPanel], ['Search in files', searchPanel], ['Git', gitPanel],
  ['Import files / .zip', () => $('#imp').click()], ['Export project (.zip)', () => exportZip().catch(e => toast(e.message))],
  ['Save all', async () => { await saveAll(); toast('All saved'); }], ['Settings', settingsPanel]
]);
const KEYS = ['⇥', '{', '}', '(', ')', '[', ']', '<', '>', '/', ';', ':', '=', '"', "'", '`', '$', '#', '_', '-', '+', '*', '&', '|', '!', '\\'];
$('#keys').innerHTML = KEYS.map(k => `<button data-k="${esc(k)}">${esc(k)}</button>`).join('');
$('#keys').addEventListener('mousedown', e => e.preventDefault());
$('#keys').addEventListener('click', e => {
  const k = e.target.dataset.k; if (!k || !S.active) return;
  if (k === '⇥') indentMore(view); else view.dispatch(view.state.replaceSelection(k));
  view.focus();
});
window.addEventListener('beforeunload', () => { saveAll(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) saveAll(); });

/* ---------- boot ---------- */
(async function init() {
  await ensureDir('/p');
  let ps = await pfs.readdir('/p');
  if (!ps.length) { await createSample('my-project'); ps = ['my-project']; }
  if (!ps.includes(S.project)) S.project = ps[0];
  localStorage.setItem('cd.project', S.project);
  renderTabs(); await refreshTree();
})();
