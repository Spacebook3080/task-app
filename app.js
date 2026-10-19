'use strict';

const KEY_CACHE = 'dtm-cache-v2';          // 画面表示用のキャッシュ（オフラインでも見られるように）
const KEY_QUEUE = 'dtm-queue-v2';          // まだサーバーに送れていない変更
const KEY_LEGACY = 'daily-task-manager-v1'; // 同期対応前のデータ
const KEY_MIGRATED = 'dtm-legacy-migrated';
const KEY_COLLAPSED = 'dtm-goal-collapsed'; // 目標ツリーで閉じている項目（この端末だけ）
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
function emptyState() { return { tasks: [], routines: [], routineDone: {}, notes: {}, goals: [] }; }
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
function hm(d) { return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }
// 締切は画面では「2026-10-25T18:00」（この端末の時刻）の形で持つ
function localDT(s) { const d = new Date(s); return fmt(d) + 'T' + hm(d); }

// ---------- サーバーとの変換 ----------
function taskRow(t) {
  return {
    id: t.id, user_id: userId(), title: t.title, date: t.date,
    time: t.time || null, priority: t.priority, tag: t.tag || null,
    due: t.due ? new Date(t.due).toISOString() : null, goal_id: t.goalId || null,
    done: t.done, done_at: iso(t.doneAt), created_at: iso(t.createdAt),
    updated_at: new Date().toISOString()
  };
}
function rowToTask(r) {
  return {
    id: r.id, title: r.title, date: r.date, time: r.time || '', priority: r.priority,
    tag: r.tag || '', due: r.due ? localDT(r.due) : '', goalId: r.goal_id || null,
    done: r.done, doneAt: r.done_at ? Date.parse(r.done_at) : null,
    createdAt: Date.parse(r.created_at)
  };
}
function routineRow(r) { return { id: r.id, user_id: userId(), title: r.title, days: r.days }; }
function goalRow(g) {
  return {
    id: g.id, user_id: userId(), parent_id: g.parentId || null, title: g.title,
    deadline: g.deadline || null, done: g.done, done_at: iso(g.doneAt), created_at: iso(g.createdAt)
  };
}
function rowToGoal(r) {
  return {
    id: r.id, parentId: r.parent_id || null, title: r.title, deadline: r.deadline || '',
    done: r.done, doneAt: r.done_at ? Date.parse(r.done_at) : null, createdAt: Date.parse(r.created_at)
  };
}

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
    const [tasks, routines, logs, notes, goals] = await Promise.all([
      fetchAll('tasks', '*', 'id'),
      fetchAll('routines', 'id,title,days,created_at', 'created_at'),
      fetchAll('routine_logs', 'routine_id,date', 'date'),
      fetchAll('notes', 'date,body', 'date'),
      // 目標のテーブルがまだ無くても、ほかのデータは読めるようにする
      fetchAll('goals', '*', 'created_at').catch(e => { console.warn(e); return null; })
    ]);
    if (mutations !== before) { setTimeout(pull, 1000); return; } // 取得中に変更されたら取り直す
    const next = emptyState();
    next.tasks = tasks.map(rowToTask);
    next.routines = routines.map(r => ({ id: r.id, title: r.title, days: r.days }));
    logs.forEach(l => (next.routineDone[l.date] = next.routineDone[l.date] || []).push(l.routine_id));
    notes.forEach(n => { next.notes[n.date] = n.body; });
    next.goals = goals ? goals.map(rowToGoal) : state.goals;
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
  // 目標は親から順に送る（親が先にないとサーバーに入らないため）
  const goals = (data.goals || []).filter(g => g && g.id && g.title);
  const depth = g => { let n = 0, p = g; while (p && p.parentId && n < 50) { p = goals.find(x => x.id === p.parentId); n++; } return n; };
  goals.slice().sort((a, b) => depth(a) - depth(b)).forEach(g => {
    const item = {
      id: g.id, parentId: g.parentId || null, title: g.title, deadline: g.deadline || '',
      done: !!g.done, doneAt: g.doneAt || null, createdAt: g.createdAt || Date.now()
    };
    const i = state.goals.findIndex(x => x.id === g.id);
    if (i >= 0) state.goals[i] = item; else state.goals.push(item);
    ops.push({ t: 'upsert', table: 'goals', row: goalRow(item) });
  });

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
      tag: t.tag || '', due: t.due || '',
      goalId: state.goals.some(g => g.id === t.goalId) ? t.goalId : null,
      done: !!t.done, doneAt: t.doneAt || null, createdAt: t.createdAt || Date.now()
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

// ---------- 目標（ツリー）のデータ ----------
function childrenOf(id) {
  return state.goals.filter(g => (g.parentId || null) === id).sort((a, b) => a.createdAt - b.createdAt);
}
function descendants(id) { return childrenOf(id).flatMap(c => [c, ...descendants(c.id)]); }
function rootOf(g) {
  for (let n = 0; g && g.parentId && n < 50; n++) {
    const p = state.goals.find(x => x.id === g.parentId);
    if (!p) break;
    g = p;
  }
  return g;
}
// 進み具合：いちばん下のステップのうち、終わった数（親が完了なら下も全部完了扱い）
function leafCount(g, parentDone) {
  const kids = childrenOf(g.id), d = parentDone || g.done;
  if (!kids.length) return { done: d ? 1 : 0, total: 1 };
  return kids.reduce((s, k) => {
    const c = leafCount(k, d);
    return { done: s.done + c.done, total: s.total + c.total };
  }, { done: 0, total: 0 });
}
// 期限までの経過時間から見て、進み具合が足りているか
function paceOf(g, p) {
  if (!g.deadline || g.done || p.total < 2) return '';
  const start = g.createdAt, end = parse(g.deadline).getTime() + 86400000;
  const expected = Math.min(1, Math.max(0, (Date.now() - start) / (end - start)));
  return p.done / p.total + 0.1 < expected ? 'late' : 'ok';
}
function deadlineTag(g) {
  if (!g.deadline) return '';
  const d = parse(g.deadline);
  const n = Math.round((d - parse(todayStr())) / 86400000);
  const label = g.done ? `${d.getMonth() + 1}/${d.getDate()}まで`
    : n < 0 ? `期限 ${-n}日すぎ` : n === 0 ? '今日まで' : `あと${n}日`;
  const cls = g.done ? '' : n < 0 ? 'overdue' : n <= 3 ? 'soon' : '';
  return `<span class="tag ${cls}" title="期限 ${d.getMonth() + 1}/${d.getDate()}">${label}</span>`;
}
function dueTag(t) {
  if (!t.due) return '';
  const d = new Date(t.due), diff = d - Date.now();
  const cls = t.done ? '' : diff < 0 ? 'overdue' : diff < 86400000 ? 'soon' : '';
  return `<span class="tag ${cls}" data-due="${t.id}" title="締切を変える">⏰ ${d.getMonth() + 1}/${d.getDate()} ${hm(d)}${!t.done && diff < 0 ? ' すぎ' : ''}</span>`;
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
    const goal = rootOf(t.goalId && state.goals.find(g => g.id === t.goalId));
    return `<li class="${t.done ? 'done' : ''}">
      <span class="pri ${t.priority}"></span>
      <input type="checkbox" data-task="${t.id}" ${t.done ? 'checked' : ''}>
      ${t.time ? `<span class="time">${t.time}</span>` : ''}
      <span class="title" data-edit="${t.id}" title="ダブルクリックで編集">${esc(t.title)}</span>
      ${overdue ? `<span class="tag overdue">持ち越し ${od.getMonth() + 1}/${od.getDate()}</span>` : ''}
      ${dueTag(t)}
      ${goal ? `<span class="tag goal">🎯 ${esc(goal.title)}</span>` : ''}
      ${t.tag ? `<span class="tag">${esc(t.tag)}</span>` : ''}
      <span class="actions">
        ${t.due ? '' : `<button data-due="${t.id}" title="締切を決める">⏰</button>`}
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

  // 目標（まだ終わっていない、いちばん上の目標だけ）
  const tops = childrenOf(null).filter(g => !g.done);
  $('goalCard').hidden = !tops.length;
  $('goalSummary').innerHTML = tops.map(g => {
    const p = leafCount(g), pct = Math.round(p.done / p.total * 100), pace = paceOf(g, p);
    return `<li data-gopen="${g.id}">
      <div class="goal-head">
        <span class="title">${esc(g.title)}</span>
        ${deadlineTag(g)}
        ${pace ? `<span class="tag ${pace === 'late' ? 'soon' : 'ok'}">${pace === 'late' ? '遅れ気味' : '順調'}</span>` : ''}
        <span class="time">${pct}%</span>
      </div>
      <div class="progress"><div style="width:${pct}%"></div></div></li>`;
  }).join('');
  if ($('goalDialog').open) renderGoalTree();

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
    due: $('newDue').value, goalId: null,
    done: false, doneAt: null, createdAt: Date.now()
  };
  state.tasks.push(t);
  $('newTitle').value = '';
  $('newTime').value = '';
  $('newDue').value = '';
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
  const ops = [{ t: 'upsert', table: 'tasks', row: taskRow(t) }];
  // 目標のステップから作ったタスクなら、ステップも一緒に完了にする
  const g = t.goalId && state.goals.find(x => x.id === t.goalId);
  if (g) {
    g.done = t.done; g.doneAt = t.doneAt;
    ops.push({ t: 'upsert', table: 'goals', row: goalRow(g) });
  }
  commit(ops);
});
taskList.addEventListener('click', e => {
  const del = e.target.dataset.del, tom = e.target.dataset.tomorrow, due = e.target.dataset.due;
  if (due) {
    const t = state.tasks.find(x => x.id === due);
    inlinePicker(e.target, 'datetime-local', t.due, v => {
      if (v === t.due) return render();
      t.due = v;
      commit([{ t: 'upsert', table: 'tasks', row: taskRow(t) }]);
    });
  } else if (del) {
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
  editTitle(e.target, t.title, v => {
    t.title = v;
    commit([{ t: 'upsert', table: 'tasks', row: taskRow(t) }]);
  });
});

// 名前をその場で書きかえる
function editTitle(el, value, onSave) {
  const input = document.createElement('input');
  input.type = 'text'; input.value = value; input.className = 'edit-input';
  el.replaceWith(input);
  input.focus(); input.select();
  let finished = false;
  const finish = ok => {
    if (finished) return; finished = true;
    const v = input.value.trim();
    if (ok && v && v !== value) onSave(v); else render();
  };
  input.addEventListener('keydown', ev => {
    if (ev.key === 'Enter') finish(true);
    if (ev.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

// 日付（または日時）の入力欄をその場に出して、決まったら保存する。空にすると取り消し
function inlinePicker(el, type, value, onSave) {
  const input = document.createElement('input');
  input.type = type; input.value = value || ''; input.className = 'inline-picker';
  el.replaceWith(input);
  input.focus();
  try { input.showPicker(); } catch (e) {}
  let finished = false;
  const finish = () => { if (finished) return; finished = true; onSave(input.value); };
  input.addEventListener('keydown', ev => {
    if (ev.key === 'Enter') finish();
    if (ev.key === 'Escape') { finished = true; render(); }
  });
  input.addEventListener('blur', finish);
  // 日付だけなら選んだ時点で決まり。日時は時刻まで入れ終わってから（Enter か欄の外を押す）
  if (type === 'date') input.addEventListener('change', finish);
}

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

// ---------- 目標の設定（ツリー） ----------
let collapsed = new Set(lsGet(KEY_COLLAPSED) || []);
let addingUnder = null; // 下にステップを追加している目標

function goalItems(g, depth) {
  const kids = childrenOf(g.id);
  const open = !collapsed.has(g.id);
  const p = leafCount(g);
  const inToday = state.tasks.some(t => t.goalId === g.id && !t.done);
  const pad = depth * 20 + 4;
  let html = `<li class="${g.done ? 'done' : ''}" style="padding-left:${pad}px">
    <button class="toggle" data-gtoggle="${g.id}" ${kids.length ? '' : 'disabled'} aria-label="開く・閉じる">${kids.length ? (open ? '▾' : '▸') : ''}</button>
    <input type="checkbox" data-goal="${g.id}" ${g.done ? 'checked' : ''}>
    <span class="title" data-gedit="${g.id}" title="ダブルクリックで編集">${esc(g.title)}</span>
    ${kids.length ? `<span class="time">${Math.round(p.done / p.total * 100)}%</span>` : ''}
    ${deadlineTag(g)}
    <span class="actions">
      <button data-gadd="${g.id}" title="下にステップを追加">＋</button>
      <button data-gdate="${g.id}" title="期限を決める">📅</button>
      ${kids.length || g.done ? '' : inToday ? '<span class="muted">今日に追加済み</span>'
        : `<button data-gtoday="${g.id}" title="今日のタスクに入れる">→今日</button>`}
      <button data-gdel="${g.id}" title="削除">✕</button>
    </span></li>`;
  if (open) html += kids.map(k => goalItems(k, depth + 1)).join('');
  if (addingUnder === g.id) {
    html += `<li style="padding-left:${pad + 20}px"><form class="add-step" data-gform="${g.id}">
      <input type="text" placeholder="ステップを入力して Enter" autocomplete="off" enterkeyhint="done" required>
      <button class="primary" type="submit">追加</button></form></li>`;
  }
  return html;
}
function renderGoalTree() {
  const tops = childrenOf(null);
  $('goalTree').innerHTML = tops.length ? tops.map(g => goalItems(g, 0)).join('')
    : '<li class="empty">まだ目標がありません</li>';
  const f = $('goalTree').querySelector('form input');
  if (f && document.activeElement !== f) f.focus();
}
function openGoals() { renderGoalTree(); if (!$('goalDialog').open) $('goalDialog').showModal(); }
function saveCollapsed() { lsSet(KEY_COLLAPSED, [...collapsed]); }
function newGoal(title, parentId, deadline) {
  const g = { id: uid(), parentId, title, deadline: deadline || '', done: false, doneAt: null, createdAt: Date.now() };
  state.goals.push(g);
  commit([{ t: 'upsert', table: 'goals', row: goalRow(g) }]);
}

$('openGoals').onclick = openGoals;
$('goalSummary').addEventListener('click', openGoals);
$('goalForm').addEventListener('submit', e => {
  e.preventDefault();
  const title = $('goalTitle').value.trim();
  if (!title) return;
  newGoal(title, null, $('goalDeadline').value);
  $('goalTitle').value = '';
  $('goalDeadline').value = '';
});

const goalTree = $('goalTree');
goalTree.addEventListener('submit', e => {
  e.preventDefault();
  const input = e.target.querySelector('input');
  const title = input.value.trim();
  if (!title) return;
  newGoal(title, e.target.dataset.gform, '');
  // 続けて入力できるように、追加欄は開いたままにする
});
goalTree.addEventListener('keydown', e => {
  if (e.key === 'Escape' && e.target.closest('form[data-gform]')) {
    e.preventDefault(); // ダイアログごと閉じないように
    addingUnder = null;
    renderGoalTree();
  }
});
goalTree.addEventListener('change', e => {
  const g = state.goals.find(x => x.id === e.target.dataset.goal);
  if (!g) return;
  g.done = e.target.checked;
  g.doneAt = g.done ? Date.now() : null;
  commit([{ t: 'upsert', table: 'goals', row: goalRow(g) }]);
});
goalTree.addEventListener('click', e => {
  const d = e.target.dataset;
  if (d.gtoggle) {
    if (collapsed.has(d.gtoggle)) collapsed.delete(d.gtoggle); else collapsed.add(d.gtoggle);
    saveCollapsed();
    renderGoalTree();
  } else if (d.gadd) {
    addingUnder = addingUnder === d.gadd ? null : d.gadd;
    collapsed.delete(d.gadd);
    saveCollapsed();
    renderGoalTree();
  } else if (d.gdate) {
    const g = state.goals.find(x => x.id === d.gdate);
    inlinePicker(e.target, 'date', g.deadline, v => {
      if (v === g.deadline) return render();
      g.deadline = v;
      commit([{ t: 'upsert', table: 'goals', row: goalRow(g) }]);
    });
  } else if (d.gtoday) {
    const g = state.goals.find(x => x.id === d.gtoday);
    const t = {
      id: uid(), title: g.title, date: todayStr(), priority: 'mid', time: '', tag: '',
      due: '', goalId: g.id, done: false, doneAt: null, createdAt: Date.now()
    };
    state.tasks.push(t);
    commit([{ t: 'upsert', table: 'tasks', row: taskRow(t) }]);
  } else if (d.gdel) {
    const g = state.goals.find(x => x.id === d.gdel);
    const ids = [g.id, ...descendants(g.id).map(x => x.id)];
    const msg = ids.length > 1
      ? `「${g.title}」と、その下のステップ${ids.length - 1}個を削除しますか？`
      : `「${g.title}」を削除しますか？`;
    if (!confirm(msg)) return;
    state.goals = state.goals.filter(x => !ids.includes(x.id));
    state.tasks.forEach(t => { if (ids.includes(t.goalId)) t.goalId = null; });
    if (ids.includes(addingUnder)) addingUnder = null;
    commit([{ t: 'delete', table: 'goals', match: { id: g.id } }]); // 下のステップはサーバー側で一緒に消える
  }
});
goalTree.addEventListener('dblclick', e => {
  const g = state.goals.find(x => x.id === e.target.dataset.gedit);
  if (!g) return;
  editTitle(e.target, g.title, v => {
    g.title = v;
    commit([{ t: 'upsert', table: 'goals', row: goalRow(g) }]);
  });
});
$('goalDialog').addEventListener('close', () => { addingUnder = null; });

// ---------- 設定・バックアップ ----------
$('openData').onclick = () => {
  $('accountInfo').textContent = session
    ? `ログイン中：${session.user.email}（PCとスマホで同期されます）`
    : 'データはこの端末のブラウザだけに保存されています。';
  $('logoutBtn').hidden = $('changePwBtn').hidden = !session;
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

// ---------- パスワード ----------
$('forgotBtn').onclick = async () => {
  const email = $('authEmail').value.trim();
  if (!email) { authMsg('上の欄にメールアドレスを入れてから押してください', true); $('authEmail').focus(); return; }
  if (!location.protocol.startsWith('http')) return;
  $('forgotBtn').disabled = true;
  authMsg('通信中…');
  const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
  $('forgotBtn').disabled = false;
  if (error) authMsg(/rate limit/i.test(error.message) ? '送信回数が多すぎます。1時間ほどおいてください' : 'エラー：' + error.message, true);
  else authMsg('パスワード再設定のメールを送りました。メールのリンクを開くと、新しいパスワードを決める画面が出ます。');
};

function openPwDialog(title) {
  $('pwDialog').querySelector('h3').textContent = title;
  $('newPass').value = $('newPass2').value = '';
  $('pwMsg').textContent = '';
  if ($('dataDialog').open) $('dataDialog').close();
  $('pwDialog').showModal();
}
$('changePwBtn').onclick = () => openPwDialog('🔑 パスワードを変更');
$('pwForm').addEventListener('submit', async e => {
  e.preventDefault();
  if ($('newPass').value !== $('newPass2').value) { $('pwMsg').textContent = '2つの入力が一致しません'; return; }
  $('pwSubmit').disabled = true;
  $('pwMsg').textContent = '通信中…';
  const { error } = await sb.auth.updateUser({ password: $('newPass').value });
  $('pwSubmit').disabled = false;
  if (error) {
    $('pwMsg').textContent = /different from the old/i.test(error.message)
      ? '今と同じパスワードです。別のものにしてください' : 'エラー：' + error.message;
    return;
  }
  $('pwMsg').textContent = '✅ 変更しました。ほかの端末でも、新しいパスワードでログインしてください。';
  setTimeout(() => $('pwDialog').close(), 2500);
});

// ---------- 起動 ----------
function showApp() { $('auth').hidden = true; $('app').hidden = false; render(); }
function showAuth() { $('app').hidden = true; $('auth').hidden = false; setAuthMode('login'); }

async function enterApp() {
  const cache = lsGet(KEY_CACHE);
  state = Object.assign(emptyState(), cache && cache.user === userId() ? cache.state : {});
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
      // 再設定メールのリンクから開いたとき
      if (event === 'PASSWORD_RECOVERY') openPwDialog('🔑 新しいパスワードを決める');
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
