'use strict';

const KEY_CACHE = 'dtm-cache-v2';          // 画面表示用のキャッシュ（オフラインでも見られるように）
const KEY_QUEUE = 'dtm-queue-v2';          // まだサーバーに送れていない変更
const KEY_LEGACY = 'daily-task-manager-v1'; // 同期対応前のデータ
const KEY_MIGRATED = 'dtm-legacy-migrated';
const WEEK = ['日','月','火','水','木','金','土'];
const PRI_ORDER = { high: 0, mid: 1, low: 2 };

const cfg = window.APP_CONFIG || {};
const sb = cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY && window.supabase
  ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY)
  : null;

let session = null;
let state = emptyState();
let queue = [];
let current = todayStr();
let filter = 'all';
let mutations = 0; // pull 中に変更が入ったかを判定する

const $ = id => document.getElementById(id);

// ---------- 小物 ----------
function emptyState() { return { tasks: [], routines: [], routineDone: {}, notes: {} }; }
function lsGet(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function fmt(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function todayStr() { return fmt(new Date()); }
function parse(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
function shift(s, n) { const d = parse(s); d.setDate(d.getDate() + n); return fmt(d); }
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function iso(ms) { return ms ? new Date(ms).toISOString() : null; }
function userId() { return session ? session.user.id : null; }

// ---------- サーバーとの変換 ----------
function taskRow(t) {
  return {
    id: t.id, user_id: userId(), title: t.title, date: t.date,
    time: t.time || null, priority: t.priority, tag: t.tag || null,
    done: t.done, done_at: iso(t.doneAt), created_at: iso(t.createdAt),
    updated_at: new Date().toISOString()
  };
}
function rowToTask(r) {
  return {
    id: r.id, title: r.title, date: r.date, time: r.time || '', priority: r.priority,
    tag: r.tag || '', done: r.done, doneAt: r.done_at ? Date.parse(r.done_at) : null,
    createdAt: Date.parse(r.created_at)
  };
}
function routineRow(r) { return { id: r.id, user_id: userId(), title: r.title, days: r.days }; }

// ---------- 保存と同期 ----------
function saveCache() { lsSet(KEY_CACHE, { user: userId(), state }); }

function setSync(s) {
  $('syncStatus').textContent = {
    ok: '☁ 同期済み', syncing: '⏳ 同期中…', offline: '📴 オフライン',
    error: '⚠ 同期エラー', local: '💾 この端末のみ'
  }[s] || '';
}

// 変更をローカルに反映して、サーバー送信キューに積む
function commit(ops) {
  mutations++;
  saveCache();
  render();
  if (sb && session && ops.length) {
    queue.push(...ops);
    lsSet(KEY_QUEUE, queue);
    flush();
  }
}

let flushing = null;
function flush() {
  if (!sb || !session) return Promise.resolve();
  if (!flushing) flushing = doFlush().finally(() => { flushing = null; });
  return flushing;
}
async function doFlush() {
  if (!queue.length) return;
  setSync('syncing');
  while (queue.length) {
    const op = queue[0];
    const q = sb.from(op.table);
    const { error } = op.t === 'upsert' ? await q.upsert(op.row) : await q.delete().match(op.match);
    if (error) {
      // データベース側のエラー（数字のコード）は再送しても直らないので捨てる
      if (/^\d/.test(error.code || '')) {
        console.warn('同期できない変更を破棄しました', op, error);
      } else {
        setSync(navigator.onLine ? 'error' : 'offline');
        return;
      }
    }
    queue.shift();
    lsSet(KEY_QUEUE, queue);
  }
  setSync('ok');
}

async function fetchAll(table, cols, orderBy) {
  let out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from(table).select(cols).order(orderBy).range(from, from + 999);
    if (error) throw error;
    out = out.concat(data);
    if (data.length < 1000) return out;
  }
}

let pulling = false;
async function pull() {
  if (!sb || !session || pulling) return;
  pulling = true;
  try {
    await flush();
    if (queue.length) return; // 送れていない変更がある間は上書きしない
    setSync('syncing');
    const before = mutations;
    const [tasks, routines, logs, notes] = await Promise.all([
      fetchAll('tasks', '*', 'id'),
      fetchAll('routines', 'id,title,days,created_at', 'created_at'),
      fetchAll('routine_logs', 'routine_id,date', 'date'),
      fetchAll('notes', 'date,body', 'date')
    ]);
    if (mutations !== before) { setTimeout(pull, 1000); return; } // 取得中に変更されたら取り直す
    const next = emptyState();
    next.tasks = tasks.map(rowToTask);
    next.routines = routines.map(r => ({ id: r.id, title: r.title, days: r.days }));
    logs.forEach(l => (next.routineDone[l.date] = next.routineDone[l.date] || []).push(l.routine_id));
    notes.forEach(n => { next.notes[n.date] = n.body; });
    state = next;
    saveCache();
    render();
    setSync('ok');
  } catch (e) {
    console.warn(e);
    setSync(navigator.onLine ? 'error' : 'offline');
  } finally {
    pulling = false;
  }
}

// 別のデータ（バックアップや同期対応前のデータ）を今のデータに追加する
function mergeData(data) {
  const ops = [];
  const routines = (data.routines || []).filter(r => r && r.id && r.title);
  routines.forEach(r => {
    const i = state.routines.findIndex(x => x.id === r.id);
    const item = { id: r.id, title: r.title, days: r.days || [0, 1, 2, 3, 4, 5, 6] };
    if (i >= 0) state.routines[i] = item; else state.routines.push(item);
  });
  if (routines.length) ops.push({ t: 'upsert', table: 'routines', row: routines.map(r => routineRow(state.routines.find(x => x.id === r.id))) });

  const tasks = (data.tasks || []).filter(t => t && t.id && t.title && t.date);
  tasks.forEach(t => {
    const item = {
      id: t.id, title: t.title, date: t.date, time: t.time || '', priority: t.priority || 'mid',
      tag: t.tag || '', done: !!t.done, doneAt: t.doneAt || null, createdAt: t.createdAt || Date.now()
    };
    const i = state.tasks.findIndex(x => x.id === t.id);
    if (i >= 0) state.tasks[i] = item; else state.tasks.push(item);
  });
  if (tasks.length) ops.push({ t: 'upsert', table: 'tasks', row: tasks.map(t => taskRow(state.tasks.find(x => x.id === t.id))) });

  const logRows = [];
  Object.entries(data.routineDone || {}).forEach(([date, ids]) => {
    const arr = state.routineDone[date] || (state.routineDone[date] = []);
    ids.forEach(id => {
      if (!arr.includes(id)) arr.push(id);
      logRows.push({ user_id: userId(), routine_id: id, date });
    });
  });
  if (logRows.length) ops.push({ t: 'upsert', table: 'routine_logs', row: logRows });

  const noteRows = [];
  Object.entries(data.notes || {}).forEach(([date, body]) => {
    if (!body) return;
    state.notes[date] = body;
    noteRows.push({ user_id: userId(), date, body, updated_at: new Date().toISOString() });
  });
  if (noteRows.length) ops.push({ t: 'upsert', table: 'notes', row: noteRows });

  commit(ops);
}

// ---------- 表示するデータ ----------
function routinesFor(date) {
  const wd = parse(date).getDay();
  return state.routines.filter(r => r.days.includes(wd));
}
function tasksFor(date) {
  const today = todayStr();
  return state.tasks.filter(t => {
    if (t.date === date) return true;
    // 今日の画面には、過去の未完了タスクを「持ち越し」として表示
    return date === today && t.date < today && !t.done;
  });
}
function sortTasks(list) {
  return list.slice().sort((a, b) =>
    (a.done - b.done) ||
    (PRI_ORDER[a.priority] - PRI_ORDER[b.priority]) ||
    (a.time || '99').localeCompare(b.time || '99') ||
    (a.createdAt - b.createdAt));
}

// ---------- 描画 ----------
function render() {
  const d = parse(current);
  const today = todayStr();
  const rel = current === today ? '今日' : current === shift(today, 1) ? '明日' : current === shift(today, -1) ? '昨日' : '';
  $('dateLabel').innerHTML =
    `${d.getMonth() + 1}月${d.getDate()}日（${WEEK[d.getDay()]}）<small>${d.getFullYear()}年 ${rel}</small>`;

  // 習慣
  const routines = routinesFor(current);
  const rDone = state.routineDone[current] || [];
  $('routineCard').hidden = !state.routines.length;
  $('routineList').innerHTML = routines.length ? routines.map(r => {
    const done = rDone.includes(r.id);
    return `<li class="${done ? 'done' : ''}">
      <input type="checkbox" data-routine="${r.id}" ${done ? 'checked' : ''}>
      <span class="title">${esc(r.title)}</span></li>`;
  }).join('') : '<li class="empty">この曜日の習慣はありません</li>';
  const rDoneCount = routines.filter(r => rDone.includes(r.id)).length;
  $('routineCount').textContent = routines.length ? `${rDoneCount}/${routines.length}` : '';

  // タスク
  const all = tasksFor(current);
  const shown = sortTasks(all.filter(t => filter === 'all' || (filter === 'done' ? t.done : !t.done)));
  $('taskList').innerHTML = shown.length ? shown.map(t => {
    const overdue = t.date < current && !t.done;
    const od = parse(t.date);
    return `<li class="${t.done ? 'done' : ''}">
      <span class="pri ${t.priority}"></span>
      <input type="checkbox" data-task="${t.id}" ${t.done ? 'checked' : ''}>
      ${t.time ? `<span class="time">${t.time}</span>` : ''}
      <span class="title" data-edit="${t.id}" title="ダブルクリックで編集">${esc(t.title)}</span>
      ${overdue ? `<span class="tag overdue">持ち越し ${od.getMonth() + 1}/${od.getDate()}</span>` : ''}
      ${t.tag ? `<span class="tag">${esc(t.tag)}</span>` : ''}
      <span class="actions">
        <button data-tomorrow="${t.id}" title="翌日に回す">→明日</button>
        <button data-del="${t.id}" title="削除">✕</button>
      </span></li>`;
  }).join('') : `<li class="empty">${all.length ? '該当するタスクはありません' : 'タスクはまだありません'}</li>`;

  // 進捗（習慣 + タスク）
  const total = all.length + routines.length;
  const done = all.filter(t => t.done).length + rDoneCount;
  $('doneCount').textContent = done;
  $('totalCount').textContent = total;
  const pct = total ? Math.round(done / total * 100) : 0;
  $('percent').textContent = total && pct === 100 ? '🎉 100%' : pct + '%';
  $('bar').style.width = pct + '%';

  // メモ
  if (document.activeElement !== $('memo')) $('memo').value = state.notes[current] || '';

  // カテゴリ候補
  const tags = [...new Set(state.tasks.map(t => t.tag).filter(Boolean))];
  $('tagList').innerHTML = tags.map(t => `<option value="${esc(t)}">`).join('');
}

// ---------- タスクの操作 ----------
$('addForm').addEventListener('submit', e => {
  e.preventDefault();
  const title = $('newTitle').value.trim();
  if (!title) return;
  const t = {
    id: uid(), title, date: current,
    priority: $('newPri').value, time: $('newTime').value, tag: $('newTag').value.trim(),
    done: false, doneAt: null, createdAt: Date.now()
  };
  state.tasks.push(t);
  $('newTitle').value = '';
  $('newTime').value = '';
  commit([{ t: 'upsert', table: 'tasks', row: taskRow(t) }]);
  $('newTitle').focus();
});

$('routineList').addEventListener('change', e => {
  const id = e.target.dataset.routine;
  if (!id) return;
  const date = current;
  const arr = state.routineDone[date] || (state.routineDone[date] = []);
  if (e.target.checked) {
    if (!arr.includes(id)) arr.push(id);
    commit([{ t: 'upsert', table: 'routine_logs', row: { user_id: userId(), routine_id: id, date } }]);
  } else {
    state.routineDone[date] = arr.filter(x => x !== id);
    commit([{ t: 'delete', table: 'routine_logs', match: { routine_id: id, date } }]);
  }
});

const taskList = $('taskList');
taskList.addEventListener('change', e => {
  const t = state.tasks.find(x => x.id === e.target.dataset.task);
  if (!t) return;
  t.done = e.target.checked;
  t.doneAt = t.done ? Date.now() : null;
  commit([{ t: 'upsert', table: 'tasks', row: taskRow(t) }]);
});
taskList.addEventListener('click', e => {
  const del = e.target.dataset.del, tom = e.target.dataset.tomorrow;
  if (del) {
    state.tasks = state.tasks.filter(t => t.id !== del);
    commit([{ t: 'delete', table: 'tasks', match: { id: del } }]);
  } else if (tom) {
    const t = state.tasks.find(x => x.id === tom);
    t.date = shift(current, 1);
    commit([{ t: 'upsert', table: 'tasks', row: taskRow(t) }]);
  }
});
taskList.addEventListener('dblclick', e => {
  const id = e.target.dataset.edit;
  if (!id) return;
  const t = state.tasks.find(x => x.id === id);
  const input = document.createElement('input');
  input.type = 'text'; input.value = t.title; input.className = 'edit-input';
  e.target.replaceWith(input);
  input.focus(); input.select();
  let finished = false;
  const finish = ok => {
    if (finished) return; finished = true;
    const v = input.value.trim();
    if (ok && v && v !== t.title) {
      t.title = v;
      commit([{ t: 'upsert', table: 'tasks', row: taskRow(t) }]);
    } else render();
  };
  input.addEventListener('keydown', ev => {
    if (ev.key === 'Enter') finish(true);
    if (ev.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
});

$('filters').addEventListener('click', e => {
  if (!e.target.dataset.f) return;
  filter = e.target.dataset.f;
  document.querySelectorAll('#filters button').forEach(b => b.classList.toggle('on', b === e.target));
  render();
});

// メモは入力が止まってから送る
const memoTimers = {};
$('memo').addEventListener('input', e => {
  const date = current, body = e.target.value;
  if (body) state.notes[date] = body; else delete state.notes[date];
  mutations++;
  saveCache();
  clearTimeout(memoTimers[date]);
  memoTimers[date] = setTimeout(() => {
    commit([body
      ? { t: 'upsert', table: 'notes', row: { user_id: userId(), date, body, updated_at: new Date().toISOString() } }
      : { t: 'delete', table: 'notes', match: { date } }]);
  }, 800);
});

$('prevDay').onclick = () => { current = shift(current, -1); render(); };
$('nextDay').onclick = () => { current = shift(current, 1); render(); };
$('todayBtn').onclick = () => { current = todayStr(); render(); };
document.addEventListener('keydown', e => {
  if (e.target.matches('input, textarea, select') || document.querySelector('dialog[open]') || $('app').hidden) return;
  if (e.key === 'ArrowLeft') { current = shift(current, -1); render(); }
  if (e.key === 'ArrowRight') { current = shift(current, 1); render(); }
});

// ---------- 習慣の設定 ----------
$('routineDays').innerHTML = WEEK.map((w, i) =>
  `<label><input type="checkbox" value="${i}" checked><span>${w}</span></label>`).join('');

function renderRoutineEdit() {
  $('routineEditList').innerHTML = state.routines.length ? state.routines.map(r => `<li>
      <span class="title">${esc(r.title)}</span>
      <span class="muted">${r.days.length === 7 ? '毎日' : r.days.map(d => WEEK[d]).join('・')}</span>
      <span class="actions" style="opacity:1"><button data-rdel="${r.id}" title="削除">✕</button></span>
    </li>`).join('') : '<li class="empty">まだ登録されていません</li>';
}
$('openRoutines').onclick = () => { renderRoutineEdit(); $('routineDialog').showModal(); };
$('routineForm').addEventListener('submit', e => {
  e.preventDefault();
  const title = $('routineTitle').value.trim();
  const days = [...document.querySelectorAll('#routineDays input:checked')].map(i => Number(i.value));
  if (!title) return;
  if (!days.length) { alert('曜日を1つ以上選んでください'); return; }
  const r = { id: uid(), title, days };
  state.routines.push(r);
  $('routineTitle').value = '';
  commit([{ t: 'upsert', table: 'routines', row: routineRow(r) }]);
  renderRoutineEdit();
});
$('routineEditList').addEventListener('click', e => {
  const id = e.target.dataset.rdel;
  if (!id) return;
  const r = state.routines.find(x => x.id === id);
  if (!confirm(`「${r.title}」を削除しますか？\nこれまでの記録も消えます。`)) return;
  state.routines = state.routines.filter(x => x.id !== id);
  Object.keys(state.routineDone).forEach(d => {
    state.routineDone[d] = state.routineDone[d].filter(x => x !== id);
  });
  commit([{ t: 'delete', table: 'routines', match: { id } }]); // 記録はサーバー側で一緒に消える
  renderRoutineEdit();
});

// ---------- 設定・バックアップ ----------
$('openData').onclick = () => {
  $('accountInfo').textContent = session
    ? `ログイン中：${session.user.email}（PCとスマホで同期されます）`
    : 'データはこの端末のブラウザだけに保存されています。';
  $('logoutBtn').hidden = !session;
  $('dataDialog').showModal();
};
$('exportBtn').onclick = () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `tasks-backup-${todayStr()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
$('importFile').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.tasks)) throw new Error('形式が違います');
    if (!confirm(`タスク${data.tasks.length}件などを今のデータに追加します。よろしいですか？`)) return;
    mergeData(data);
    $('dataDialog').close();
  } catch (err) { alert('ファイルを読み込めませんでした'); }
});
$('logoutBtn').onclick = async () => {
  if (queue.length && !confirm('まだ送れていない変更があります。ログアウトすると消えますが、よろしいですか？')) return;
  await sb.auth.signOut();
};

// ---------- ログイン ----------
let authMode = 'login';
function setAuthMode(mode) {
  authMode = mode;
  $('authSubmit').textContent = mode === 'login' ? 'ログイン' : '新規登録';
  $('authSwitchText').textContent = mode === 'login' ? 'はじめて使う場合は' : 'アカウントがある場合は';
  $('authSwitch').textContent = mode === 'login' ? '新規登録' : 'ログイン';
  $('authPass').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  authMsg('');
}
function authMsg(text, isErr) {
  $('authMsg').textContent = text;
  $('authMsg').className = isErr ? 'err' : 'muted';
}
$('authSwitch').onclick = () => setAuthMode(authMode === 'login' ? 'signup' : 'login');
$('authForm').addEventListener('submit', async e => {
  e.preventDefault();
  const email = $('authEmail').value.trim(), password = $('authPass').value;
  $('authSubmit').disabled = true;
  authMsg('通信中…');
  try {
    if (authMode === 'signup') {
      const opts = location.protocol.startsWith('http') ? { emailRedirectTo: location.origin + location.pathname } : {};
      const { data, error } = await sb.auth.signUp({ email, password, options: opts });
      if (error) throw error;
      if (!data.session) {
        setAuthMode('login');
        authMsg('確認メールを送りました。メールのリンクを押してから、ここでログインしてください。');
      }
    } else {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
    }
  } catch (err) {
    const m = err.message || '';
    authMsg(
      /Invalid login/i.test(m) ? 'メールアドレスかパスワードが違います' :
      /not confirmed/i.test(m) ? 'メールの確認がまだです。届いたメールのリンクを押してください' :
      /already registered/i.test(m) ? 'このメールアドレスは登録済みです。ログインしてください' :
      /rate limit/i.test(m) ? '試行回数が多すぎます。少し時間をおいてください' :
      'エラー：' + m, true);
  } finally {
    $('authSubmit').disabled = false;
  }
});

// ---------- 起動 ----------
function showApp() { $('auth').hidden = true; $('app').hidden = false; render(); }
function showAuth() { $('app').hidden = true; $('auth').hidden = false; setAuthMode('login'); }

async function enterApp() {
  const cache = lsGet(KEY_CACHE);
  state = cache && cache.user === userId() ? cache.state : emptyState();
  queue = lsGet(KEY_QUEUE) || [];
  showApp();
  await pull();
  maybeMigrateLegacy();
}

function maybeMigrateLegacy() {
  const legacy = lsGet(KEY_LEGACY);
  if (!legacy || lsGet(KEY_MIGRATED)) return;
  if ((legacy.tasks || []).length || (legacy.routines || []).length) {
    if (confirm('この端末に、同期対応前のデータがあります。アカウントに取り込みますか？')) mergeData(legacy);
  }
  lsSet(KEY_MIGRATED, true);
}

async function init() {
  if (!sb) {
    // Supabase 未設定：この端末だけに保存
    const cache = lsGet(KEY_CACHE);
    state = cache ? cache.state : (lsGet(KEY_LEGACY) || emptyState());
    state = Object.assign(emptyState(), state);
    showApp();
    setSync('local');
    return;
  }
  sb.auth.onAuthStateChange((event, s) => {
    const prev = session;
    session = s;
    // コールバックの中で Supabase を待つと固まるので、次のタイミングで処理する
    setTimeout(() => {
      if (event === 'SIGNED_OUT') {
        lsDel(KEY_CACHE); lsDel(KEY_QUEUE);
        state = emptyState(); queue = [];
        $('dataDialog').close();
        showAuth();
      } else if (s && !prev) {
        enterApp();
      }
    }, 0);
  });
  const { data } = await sb.auth.getSession();
  if (!data.session) showAuth();
  // ログイン済みなら onAuthStateChange（INITIAL_SESSION）から enterApp が呼ばれる
}

document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') pull(); });
window.addEventListener('online', () => pull());
setInterval(() => { if (document.visibilityState === 'visible') pull(); }, 60000);

// 日付が変わったら自動で「今日」に追従
let lastToday = todayStr();
setInterval(() => {
  const t = todayStr();
  if (t !== lastToday) { if (current === lastToday) current = t; lastToday = t; render(); }
}, 60000);

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(e => console.warn(e));
}

init();
