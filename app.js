'use strict';

const KEY_CACHE = 'dtm-cache-v2';          // 画面表示用のキャッシュ（オフラインでも見られるように）
const KEY_QUEUE = 'dtm-queue-v2';          // まだサーバーに送れていない変更
const KEY_LEGACY = 'daily-task-manager-v1'; // 同期対応前のデータ
const KEY_MIGRATED = 'dtm-legacy-migrated';
const KEY_COLLAPSED = 'dtm-goal-collapsed'; // 目標ツリーで閉じている項目（この端末だけ）
const KEY_REVIEW_DAY = 'dtm-review-day';    // 週の振り返りをする曜日（この端末だけ）
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
function emptyState() { return { tasks: [], routines: [], routineDone: {}, notes: {}, goals: [], aiMessages: [] }; }
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
// Claude からの便り（書くのは Edge Function「ai」。アプリは既読とステップの追加済みだけを書きかえる）
function aiRow(m) {
  return {
    id: m.id, user_id: userId(), kind: m.kind, period_end: m.periodEnd || null, body: m.body,
    steps: m.steps, created_at: iso(m.createdAt), read_at: iso(m.readAt)
  };
}
function rowToAi(r) {
  return {
    id: r.id, kind: r.kind, periodEnd: r.period_end || '', body: r.body, steps: r.steps || [],
    createdAt: Date.parse(r.created_at), readAt: r.read_at ? Date.parse(r.read_at) : null
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
    const [tasks, routines, logs, notes, goals, ai] = await Promise.all([
      fetchAll('tasks', '*', 'id'),
      fetchAll('routines', 'id,title,days,created_at', 'created_at'),
      fetchAll('routine_logs', 'routine_id,date', 'date'),
      fetchAll('notes', 'date,body', 'date'),
      // 目標のテーブルがまだ無くても、ほかのデータは読めるようにする
      fetchAll('goals', '*', 'created_at').catch(e => { console.warn(e); return null; }),
      fetchAll('ai_messages', '*', 'created_at').catch(e => { console.warn(e); return null; })
    ]);
    if (mutations !== before) { setTimeout(pull, 1000); return; } // 取得中に変更されたら取り直す
    const next = emptyState();
    next.tasks = tasks.map(rowToTask);
    next.routines = routines.map(r => ({ id: r.id, title: r.title, days: r.days }));
    logs.forEach(l => (next.routineDone[l.date] = next.routineDone[l.date] || []).push(l.routine_id));
    notes.forEach(n => { next.notes[n.date] = n.body; });
    next.goals = goals ? goals.map(rowToGoal) : state.goals;
    next.aiMessages = ai ? ai.map(rowToAi) : (state.aiMessages || []);
    state = next;
    saveCache();
    render();
    setSync('ok');
    syncCalendar();
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
// recent はこの 7 日で終わった数、last は最後に終わった日時
const RECENT_DAYS = 7;
// いちばん下のステップそれぞれの、終わった日時（終わっていなければ undefined）
function leafTimes(g, parentAt) {
  const kids = childrenOf(g.id);
  const at = g.done ? (g.doneAt || 0) : parentAt;
  return kids.length ? kids.flatMap(k => leafTimes(k, at)) : [at];
}
function leafCount(g) {
  const times = leafTimes(g), since = Date.now() - RECENT_DAYS * 86400000;
  const done = times.filter(t => t !== undefined);
  return { done: done.length, total: times.length, recent: done.filter(t => t >= since).length, last: Math.max(0, ...done) };
}
// 段階の名前：いちばん上がビジョン、その下が目標、さらに下はステップ
const LEVELS = ['ビジョン', '目標', 'ステップ'];
function levelName(depth) { return LEVELS[Math.min(depth, LEVELS.length - 1)]; }
// 次にやるステップ：上から順に見て、最初のまだ終わっていない、いちばん下のステップ
function nextStep(g) {
  for (const k of childrenOf(g.id)) {
    if (k.done) continue;
    if (!childrenOf(k.id).length) return k;
    const n = nextStep(k);
    if (n) return n;
  }
  return null;
}
function goalToToday(g) {
  const t = {
    id: uid(), title: g.title, date: todayStr(), priority: 'mid', time: '', tag: '',
    due: '', goalId: g.id, done: false, doneAt: null, createdAt: Date.now()
  };
  state.tasks.push(t);
  commit([{ t: 'upsert', table: 'tasks', row: taskRow(t) }]);
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
    const recentPct = p.recent / p.total * 100;
    const ago = p.last ? Math.round((parse(todayStr()) - parse(fmt(new Date(p.last)))) / 86400000) : -1;
    const recent = p.total < 2 ? ''
      : p.recent ? `<span class="up">この${RECENT_DAYS}日で +${p.recent}ステップ</span>`
      : `<span>この${RECENT_DAYS}日は進みなし${ago > 0 ? `（最後に進んだのは${ago}日前）` : ''}</span>`;
    const next = nextStep(g);
    const inToday = next && state.tasks.some(t => t.goalId === next.id && !t.done);
    return `<li data-gopen="${g.id}">
      <div class="goal-head">
        <span class="title">${esc(g.title)}</span>
        ${deadlineTag(g)}
        ${pace ? `<span class="tag ${pace === 'late' ? 'soon' : 'ok'}">${pace === 'late' ? '遅れ気味' : '順調'}</span>` : ''}
        <span class="time">${p.total > 1 ? `${p.done}/${p.total}ステップ・` : ''}${pct}%</span>
      </div>
      <div class="progress"><div style="width:${pct - recentPct}%"></div><div class="recent" style="width:${recentPct}%"></div></div>
      ${recent ? `<div class="goal-recent muted">${recent}</div>` : ''}
      ${next ? `<div class="goal-next">
        <span class="muted">次：</span><span class="title">${esc(next.title)}</span>
        ${inToday ? '<span class="muted">今日に追加済み</span>'
          : `<button data-gtoday="${next.id}" title="今日のタスクに入れる">→今日</button>`}
      </div>` : ''}</li>`;
  }).join('');
  if ($('goalDialog').open) renderGoalTree();

  renderReview();
  renderAi();

  // メモ
  if (document.activeElement !== $('memo')) $('memo').value = state.notes[current] || '';

  // カテゴリ候補
  const tags = [...new Set(state.tasks.map(t => t.tag).filter(Boolean))];
  $('tagList').innerHTML = tags.map(t => `<option value="${esc(t)}">`).join('');
}

// ---------- 週の振り返り ----------
// 振り返りは、その日のメモの中に下の形で保存する（メモ欄から読んでも分かるように）
const REVIEW_START = '【週の振り返り】', REVIEW_END = '【振り返りここまで】';
const REVIEW_FIELDS = [['good', 'よかったこと'], ['bad', 'うまくいかなかったこと'], ['next', '来週やること']];
let reviewDirty = null; // 入力中で、まだ保存していない日付

function reviewDay() { const v = lsGet(KEY_REVIEW_DAY); return v === null ? 0 : v; }
function readReview(date) {
  const body = state.notes[date] || '';
  const i = body.indexOf(REVIEW_START), j = body.indexOf(REVIEW_END);
  const out = { good: '', bad: '', next: '' };
  if (i < 0 || j < i) return out;
  const block = body.slice(i + REVIEW_START.length, j);
  REVIEW_FIELDS.forEach(([k, label], n) => {
    const a = block.indexOf(`■${label}\n`);
    if (a < 0) return;
    const rest = block.slice(a + label.length + 2);
    const nextLabel = REVIEW_FIELDS.slice(n + 1).map(f => rest.indexOf(`■${f[1]}\n`)).find(x => x >= 0);
    out[k] = rest.slice(0, nextLabel === undefined ? rest.length : nextLabel).trim();
  });
  return out;
}
function writeReview(date, r) {
  let body = state.notes[date] || '';
  const i = body.indexOf(REVIEW_START), j = body.indexOf(REVIEW_END);
  if (i >= 0 && j > i) body = (body.slice(0, i) + body.slice(j + REVIEW_END.length)).trim();
  if (REVIEW_FIELDS.some(([k]) => r[k])) {
    const block = [REVIEW_START, ...REVIEW_FIELDS.flatMap(([k, label]) => [`■${label}`, r[k]]), REVIEW_END].join('\n');
    body = body ? body + '\n\n' + block : block;
  }
  if (body) state.notes[date] = body; else delete state.notes[date];
  commit([body
    ? { t: 'upsert', table: 'notes', row: { user_id: userId(), date, body, updated_at: new Date().toISOString() } }
    : { t: 'delete', table: 'notes', match: { date } }]);
}

// 今日を含む 7 日間の記録をまとめる
function weekSummary(end) {
  const start = shift(end, -6);
  const from = parse(start).getTime(), to = parse(end).getTime() + 86400000;
  const inWeek = t => t !== undefined && t !== null && t >= from && t < to;
  const tasks = state.tasks.filter(t => t.done && inWeek(t.doneAt));
  let rTotal = 0, rDone = 0;
  for (let d = start; d <= end; d = shift(d, 1)) {
    const rs = routinesFor(d), done = state.routineDone[d] || [];
    rTotal += rs.length;
    rDone += rs.filter(r => done.includes(r.id)).length;
  }
  const goals = childrenOf(null).filter(g => !g.done).map(g => {
    const steps = descendants(g.id).filter(s => s.done && inWeek(s.doneAt) && !childrenOf(s.id).length);
    return { g, gained: leafTimes(g).filter(inWeek).length, steps, next: nextStep(g), p: leafCount(g) };
  });
  return { start, end, tasks, rTotal, rDone, goals };
}

function renderReview() {
  const show = parse(current).getDay() === reviewDay();
  $('reviewCard').hidden = !show;
  if (!show) return;
  const w = weekSummary(current), s = parse(w.start), e = parse(w.end);
  $('reviewRange').textContent = `${s.getMonth() + 1}/${s.getDate()}〜${e.getMonth() + 1}/${e.getDate()}`;
  $('reviewStats').innerHTML = `
    <span>終えたタスク <b>${w.tasks.length}</b> 件</span>
    ${w.rTotal ? `<span>習慣 <b>${Math.round(w.rDone / w.rTotal * 100)}</b>%（${w.rDone}/${w.rTotal}）</span>` : ''}
    <span>進んだステップ <b>${w.goals.reduce((n, x) => n + x.gained, 0)}</b></span>`;
  $('reviewGoals').innerHTML = w.goals.map(x => `<li>
      <span class="title">${esc(x.g.title)}</span>
      ${x.gained ? `<span class="up">+${x.gained}ステップ</span>` : '<span class="tag soon">進みなし</span>'}
      <span class="time">${Math.round(x.p.done / x.p.total * 100)}%</span></li>`).join('');
  const last = readReview(shift(current, -7)).next;
  $('reviewLast').hidden = !last;
  $('reviewLast').textContent = last ? `先週決めた「来週やること」\n${last}` : '';
  // 入力中のものは、画面を描き直しても消さない
  if (reviewDirty !== current) {
    const r = readReview(current);
    $('reviewGood').value = r.good; $('reviewBad').value = r.bad; $('reviewNext').value = r.next;
    reviewDirty = null;
  }
}
function reviewInput() {
  return { good: $('reviewGood').value.trim(), bad: $('reviewBad').value.trim(), next: $('reviewNext').value.trim() };
}
function reviewPrompt() {
  const w = weekSummary(current), r = reviewInput(), last = readReview(shift(current, -7)).next;
  const lines = [
    `今週（${w.start}〜${w.end}）の振り返りを手伝ってください。`,
    '',
    `終えたタスク：${w.tasks.length} 件${w.tasks.length ? '（' + w.tasks.slice(0, 20).map(t => t.title).join('、') + '）' : ''}`,
    w.rTotal ? `習慣：${w.rDone}/${w.rTotal} 回できた` : '習慣：登録なし',
    '',
    'ビジョン・目標ごとの進み具合：',
    ...w.goals.flatMap(x => [
      `- ${x.g.title}：全体 ${x.p.done}/${x.p.total} ステップ、今週 +${x.gained}${x.g.deadline ? `、期限 ${x.g.deadline}` : ''}`,
      ...x.steps.map(s => `  - 今週終えた：${s.title}`),
      ...(x.next ? [`  - 次のステップ：${x.next.title}`] : []),
    ]),
  ];
  if (last) lines.push('', `先週決めた「来週やること」：\n${last}`);
  if (REVIEW_FIELDS.some(([k]) => r[k])) {
    lines.push('', '私の振り返り：', ...REVIEW_FIELDS.filter(([k]) => r[k]).map(([k, label]) => `- ${label}：${r[k]}`));
  }
  lines.push('',
    'お願い：',
    '- 今週の良かった点と、止まっている目標があればその理由を一緒に考えてください（わからないことは質問してください）',
    '- 来週やることを 3 つくらいに絞って提案してください',
    '- ステップの分け方を直したほうがよければ、どの目標の下に何を足すかを「- 」の箇条書きで出してください');
  return lines.join('\n');
}
['reviewGood', 'reviewBad', 'reviewNext'].forEach(id => $(id).addEventListener('input', () => {
  reviewDirty = current;
  $('reviewMsg').textContent = '';
}));
$('reviewForm').addEventListener('submit', e => {
  e.preventDefault();
  reviewDirty = null;
  writeReview(current, reviewInput());
  $('reviewMsg').textContent = '保存しました（その日のメモにも入ります）';
});
$('reviewAi').onclick = () => {
  copyText(reviewPrompt()).then(ok => {
    $('reviewMsg').textContent = ok ? '相談文をコピーしました。Claude アプリに貼ってください' : 'コピーできませんでした';
  });
};
$('reviewDay').innerHTML = WEEK.map((w, i) => `<option value="${i}">${w}曜日</option>`).join('');
$('reviewDay').value = reviewDay();
$('reviewDay').addEventListener('change', e => { lsSet(KEY_REVIEW_DAY, Number(e.target.value)); render(); });

// ---------- Claude からの便り ----------
// まだ「読んだ」にしていない便りのうち、いちばん新しいものを表示する
function currentAi() {
  return (state.aiMessages || []).filter(m => !m.readAt).sort((a, b) => b.createdAt - a.createdAt)[0];
}
function aiDateText(m) {
  const d = new Date(m.createdAt);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${hm(d)}`;
}
function aiStepsHtml(m) {
  return m.steps.length ? '<li class="muted ai-steps-head">ステップ案（押すと目標に入ります）</li>' + m.steps.map((s, i) => {
    const parent = state.goals.find(g => g.id === s.parent_id);
    return `<li class="${s.added ? 'done' : ''}">
      <span class="title">${esc(s.title)}<small class="muted">${parent ? `　${esc(parent.title)} の下` : '　（元の目標がありません）'}</small></span>
      ${s.added ? '<span class="muted">追加済み</span>'
        : parent ? `<button data-aimsg="${m.id}" data-aistep="${i}">追加</button>` : ''}</li>`;
  }).join('') : '';
}
function renderAi() {
  const all = (state.aiMessages || []);
  const unread = all.filter(m => !m.readAt).length;
  $('openAi').hidden = !all.length;
  $('openAi').textContent = unread ? `🤖 ${unread}` : '🤖';
  if ($('aiDialog').open) renderAiHistory();
  const m = currentAi();
  $('aiCard').hidden = !m;
  if (!m) return;
  $('aiDate').textContent = aiDateText(m);
  $('aiBody').textContent = m.body;
  $('aiSteps').innerHTML = aiStepsHtml(m);
}
// これまでに届いた便りを新しい順に並べる（「読んだ」にしたものもここで読み返せる）
function renderAiHistory() {
  const list = [...(state.aiMessages || [])].sort((a, b) => b.createdAt - a.createdAt);
  $('aiHistory').innerHTML = list.map((m, i) => `
    <details class="ai-past" ${i === 0 ? 'open' : ''}>
      <summary>${aiDateText(m)}${m.readAt ? '' : ' <span class="ai-new">未読</span>'}</summary>
      <div class="ai-body"></div>
      <ul class="list ai-steps">${aiStepsHtml(m)}</ul>
    </details>`).join('') || '<p class="muted">まだ届いていません。</p>';
  // 本文は textContent で入れる（Claude の文をそのまま表示するため）
  $('aiHistory').querySelectorAll('.ai-body').forEach((el, i) => { el.textContent = list[i].body; });
}
$('openAi').onclick = () => { renderAiHistory(); $('aiDialog').showModal(); };
function addAiStep(e) {
  const { aimsg, aistep } = e.target.dataset;
  const m = (state.aiMessages || []).find(x => x.id === aimsg);
  if (aistep === undefined || !m) return;
  const s = m.steps[aistep];
  const g = { id: uid(), parentId: s.parent_id, title: s.title, deadline: '', done: false, doneAt: null, createdAt: Date.now() };
  state.goals.push(g);
  s.added = true;
  commit([{ t: 'upsert', table: 'goals', row: goalRow(g) }, { t: 'upsert', table: 'ai_messages', row: aiRow(m) }]);
}
$('aiSteps').addEventListener('click', addAiStep);
$('aiHistory').addEventListener('click', addAiStep);
$('aiRead').onclick = () => {
  const m = currentAi();
  if (!m) return;
  m.readAt = Date.now();
  commit([{ t: 'upsert', table: 'ai_messages', row: aiRow(m) }]);
};

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
  $('newPri').value = 'mid';
  $('newTime').value = '';
  $('newTag').value = '';
  $('newDue').value = '';
  setAddMore(false);
  commit([{ t: 'upsert', table: 'tasks', row: taskRow(t) }]);
  $('newTitle').focus();
});
// 優先度・時間・カテゴリ・締切は「詳しく」を押したときだけ出す
function setAddMore(open) {
  $('addMoreBox').hidden = !open;
  $('addMore').setAttribute('aria-expanded', open);
  $('addMore').textContent = open ? '閉じる ▴' : '詳しく ▾';
}
$('addMore').onclick = () => setAddMore($('addMoreBox').hidden);

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
let pastingUnder = null, pasteText = '', pasteNote = ''; // Claude の返事を貼っている目標

function goalItems(g, depth) {
  const kids = childrenOf(g.id);
  const open = !collapsed.has(g.id);
  const p = leafCount(g);
  const inToday = state.tasks.some(t => t.goalId === g.id && !t.done);
  const pad = depth * 20 + 4;
  let html = `<li class="${g.done ? 'done' : ''}" style="padding-left:${pad}px">
    <button class="toggle" data-gtoggle="${g.id}" ${kids.length ? '' : 'disabled'} aria-label="開く・閉じる">${kids.length ? (open ? '▾' : '▸') : ''}</button>
    <input type="checkbox" data-goal="${g.id}" ${g.done ? 'checked' : ''}>
    ${depth < LEVELS.length - 1 ? `<span class="tag lv${depth}">${levelName(depth)}</span>` : ''}
    <span class="title" data-gedit="${g.id}" title="ダブルクリックで編集">${esc(g.title)}</span>
    ${kids.length ? `<span class="time">${Math.round(p.done / p.total * 100)}%</span>` : ''}
    ${deadlineTag(g)}
    <span class="actions">
      <button data-gadd="${g.id}" title="下に${levelName(depth + 1)}を追加">＋</button>
      ${g.done ? '' : `<button data-gai="${g.id}" title="Claude に${levelName(depth + 1)}を相談">🤖</button>`}
      <button data-gdate="${g.id}" title="期限を決める">📅</button>
      <button data-gmove="${g.id}" title="別の場所へ移す">↪</button>
      ${kids.length || g.done ? '' : inToday ? '<span class="muted">今日に追加済み</span>'
        : `<button data-gtoday="${g.id}" title="今日のタスクに入れる">→今日</button>`}
      <button data-gdel="${g.id}" title="削除">✕</button>
    </span></li>`;
  if (open) html += kids.map(k => goalItems(k, depth + 1)).join('');
  if (addingUnder === g.id) {
    html += `<li style="padding-left:${pad + 20}px"><form class="add-step" data-gform="${g.id}">
      <input type="text" placeholder="${levelName(depth + 1)}を入力して Enter" autocomplete="off" enterkeyhint="done" required>
      <button class="primary" type="submit">追加</button></form></li>`;
  }
  if (pastingUnder === g.id) {
    html += `<li style="padding-left:${pad + 20}px"><form class="paste-steps" data-gpaste="${g.id}">
      <p class="muted">${pasteNote}</p>
      <textarea placeholder="- ステップ1&#10;  - 細かいステップ&#10;- ステップ2">${esc(pasteText)}</textarea>
      <div class="row"><button class="primary" type="submit">まとめて追加</button>
      <button type="button" data-gpcancel>やめる</button></div></form></li>`;
  }
  return html;
}

// Claude に貼る依頼文
function stepPrompt(g) {
  const lines = (id, depth) => childrenOf(id).flatMap(k =>
    [`${'  '.repeat(depth)}- ${k.done ? '[済] ' : ''}${k.title}`, ...lines(k.id, depth + 1)]);
  const now = lines(g.id, 0);
  const path = [];
  for (let p = g; p; p = p.parentId && state.goals.find(x => x.id === p.parentId)) path.unshift(p.title);
  const depth = path.length - 1, me = levelName(depth), child = levelName(depth + 1);
  return [
    depth === 0
      ? '人生のビジョンを、期限つきの目標に分けるのを手伝ってください。'
      : `${me}を、実行できる小さなステップに分けるのを手伝ってください。`,
    '',
    `${me}：${path.join(' › ')}`,
    `期限：${g.deadline || 'なし'}（今日は ${todayStr()}）`,
    now.length ? `今ある${child}：\n${now.join('\n')}` : `今ある${child}：まだありません`,
    '',
    '進め方：',
    '- 分け方を決めるのにわからないことがあれば、まず私に質問してください',
    ...(depth === 0 ? [
      '- 目標は「いつまでに・何を・どれくらい」がはっきりしたものにしてください（例：3 月までに TOEIC 800 点）',
      '- 目標の期限は、行の最後に（期限 2027-03-31）の形で書いてください',
      '- それぞれの目標の下に、最初のステップを字下げして書いてもかまいません',
    ] : [
      '- ステップは 1 つ 30 分〜2 時間くらいでできる大きさにしてください',
    ]),
    `- 今ある${child}と同じものは入れないでください`,
    '- 決まったら、最後に「- 」で始まる箇条書きだけで一覧を出してください。グループに分けるときは半角スペース 2 つで字下げしてください',
  ].join('\n');
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch (e) {}
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (e) {}
  ta.remove();
  return ok;
}
// 箇条書きを読んで、字下げどおりにステップを作る
function addPastedSteps(rootId, text) {
  const MARK = /^(?:[-*+•]\s+|・\s*|\d+[.)．、]\s*|\[[ xX]\]\s*)/;
  let rows = text.replace(/\t/g, '    ').replace(/　/g, '  ').split(/\r?\n/)
    .filter(l => l.trim() && !l.trim().startsWith('```'));
  // 前後に説明文があっても、箇条書きの行だけを使う
  if (rows.some(l => MARK.test(l.trim()))) rows = rows.filter(l => MARK.test(l.trim()));
  const stack = [], ops = [];
  let n = 0;
  rows.forEach(l => {
    const indent = l.length - l.trimStart().length;
    let title = l.trim();
    while (MARK.test(title)) title = title.replace(MARK, '');
    title = title.replace(/\*\*/g, '').trim(); // 太字の記号
    // 行の最後の「（期限 2027-03-31）」は期限として読む
    let deadline = '';
    title = title.replace(/\s*[（(]期限[:：]?\s*(\d{4}-\d{2}-\d{2})[）)]\s*$/, (m, d) => { deadline = d; return ''; }).trim();
    if (!title) return;
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const parentId = stack.length ? stack[stack.length - 1].id : rootId;
    const g = { id: uid(), parentId, title, deadline, done: false, doneAt: null, createdAt: Date.now() + n++ };
    state.goals.push(g);
    ops.push({ t: 'upsert', table: 'goals', row: goalRow(g) });
    stack.push({ indent, id: g.id });
  });
  if (ops.length) commit(ops);
  return ops.length;
}
function renderGoalTree() {
  const tops = childrenOf(null);
  $('goalTree').innerHTML = tops.length ? tops.map(g => goalItems(g, 0)).join('')
    : '<li class="empty">まだ目標がありません</li>';
  const f = $('goalTree').querySelector('form input, form textarea');
  if (f && document.activeElement !== f) f.focus();
}
// 移す先を選ぶ欄をその場に出す（自分と、自分の下にあるものは選べない）
function moveGoal(el, g) {
  const ng = new Set([g.id, ...descendants(g.id).map(x => x.id)]);
  const opts = (id, depth) => childrenOf(id).filter(k => !ng.has(k.id)).flatMap(k =>
    [`<option value="${k.id}" ${k.id === g.parentId ? 'selected' : ''}>${'　'.repeat(depth)}${esc(k.title)}（${levelName(depth)}）の下</option>`,
     ...opts(k.id, depth + 1)]);
  const sel = document.createElement('select');
  sel.className = 'inline-picker';
  sel.innerHTML = `<option value="" disabled>移す先を選ぶ</option>
    <option value="top" ${g.parentId ? '' : 'selected'}>いちばん上（ビジョン）</option>${opts(null, 0).join('')}`;
  el.replaceWith(sel);
  sel.focus();
  let finished = false;
  const finish = () => {
    if (finished) return; finished = true;
    const to = sel.value === 'top' ? null : sel.value;
    if (!sel.value || to === (g.parentId || null)) return render();
    g.parentId = to;
    if (to) { collapsed.delete(to); saveCollapsed(); }
    commit([{ t: 'upsert', table: 'goals', row: goalRow(g) }]);
  };
  sel.addEventListener('change', finish);
  sel.addEventListener('blur', finish);
  sel.addEventListener('keydown', ev => { if (ev.key === 'Escape') { ev.preventDefault(); finished = true; render(); } });
}
function openGoals() { renderGoalTree(); if (!$('goalDialog').open) $('goalDialog').showModal(); }
function saveCollapsed() { lsSet(KEY_COLLAPSED, [...collapsed]); }
function newGoal(title, parentId, deadline) {
  const g = { id: uid(), parentId, title, deadline: deadline || '', done: false, doneAt: null, createdAt: Date.now() };
  state.goals.push(g);
  commit([{ t: 'upsert', table: 'goals', row: goalRow(g) }]);
}

$('openGoals').onclick = openGoals;
$('goalSummary').addEventListener('click', e => {
  const id = e.target.dataset.gtoday;
  if (id) goalToToday(state.goals.find(x => x.id === id)); else openGoals();
});
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
  if (e.target.dataset.gpaste) {
    const id = e.target.dataset.gpaste;
    const n = addPastedSteps(id, e.target.querySelector('textarea').value);
    if (!n) { alert('ステップが見つかりませんでした。「- 」で始まる箇条書きを貼ってください。'); return; }
    pastingUnder = null; pasteText = '';
    collapsed.delete(id);
    saveCollapsed();
    renderGoalTree();
    return;
  }
  const input = e.target.querySelector('input');
  const title = input.value.trim();
  if (!title) return;
  newGoal(title, e.target.dataset.gform, '');
  // 続けて入力できるように、追加欄は開いたままにする
});
goalTree.addEventListener('keydown', e => {
  if (e.key === 'Escape' && e.target.closest('form[data-gform], form[data-gpaste]')) {
    e.preventDefault(); // ダイアログごと閉じないように
    addingUnder = pastingUnder = null;
    renderGoalTree();
  }
});
// 貼った文は、画面が描き直されても消えないように覚えておく
goalTree.addEventListener('input', e => {
  if (e.target.closest('form[data-gpaste]')) pasteText = e.target.value;
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
  } else if (d.gai) {
    const g = state.goals.find(x => x.id === d.gai);
    addingUnder = null;
    pastingUnder = d.gai; pasteText = '';
    pasteNote = '依頼文をコピーしています…';
    renderGoalTree();
    copyText(stepPrompt(g)).then(ok => {
      pasteNote = ok
        ? '依頼文をコピーしました。Claude アプリに貼って相談し、最後に出てきた箇条書きをここに貼ってください。'
        : 'コピーできませんでした。下の依頼文を選んでコピーし、Claude の返事が来たら書きかえてください。';
      if (!ok) pasteText = stepPrompt(g);
      renderGoalTree();
    });
  } else if (d.gmove) {
    moveGoal(e.target, state.goals.find(x => x.id === d.gmove));
  } else if (d.gpcancel !== undefined) {
    pastingUnder = null; pasteText = '';
    renderGoalTree();
  } else if (d.gdate) {
    const g = state.goals.find(x => x.id === d.gdate);
    inlinePicker(e.target, 'date', g.deadline, v => {
      if (v === g.deadline) return render();
      g.deadline = v;
      commit([{ t: 'upsert', table: 'goals', row: goalRow(g) }]);
    });
  } else if (d.gtoday) {
    goalToToday(state.goals.find(x => x.id === d.gtoday));
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
$('goalDialog').addEventListener('close', () => { addingUnder = pastingUnder = null; pasteText = ''; });

// ---------- 設定・バックアップ ----------
$('openData').onclick = () => {
  $('accountInfo').textContent = session
    ? `ログイン中：${session.user.email}（PCとスマホで同期されます）`
    : 'データはこの端末のブラウザだけに保存されています。';
  $('logoutBtn').hidden = $('changePwBtn').hidden = !session;
  $('dataDialog').showModal();
  loadNotify();
  loadCalendar();
  loadAiToken();
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

// ---------- Google カレンダーの取り込み ----------
// iCal は Edge Function「calendar」が代わりに読む。予定 → タスクはこの端末で行い、
// calendar_imports に「もう入れた予定」を記録して、二重に入れたり消したタスクを戻したりしないようにする
const ICAL_LIB = 'https://cdn.jsdelivr.net/npm/ical.js@1.5.0/build/ical.min.js';
const CAL_DAYS = 7;              // 今日から何日分を取り込むか
const CAL_INTERVAL = 10 * 60000; // 取り込みの間隔
let calSyncedAt = 0;
let calSyncing = false;

function calMsg(text) { $('calMsg').textContent = text; }
function loadScript(src) {
  return new Promise((ok, ng) => {
    if (document.querySelector(`script[src="${src}"]`)) return ok();
    const s = document.createElement('script');
    s.src = src; s.onload = ok; s.onerror = () => ng(new Error('部品を読み込めませんでした'));
    document.head.appendChild(s);
  });
}
function icalDate(t) {
  return t.isDate ? `${t.year}-${String(t.month).padStart(2, '0')}-${String(t.day).padStart(2, '0')}` : fmt(t.toJSDate());
}

// iCal の中から from〜to の日の予定を取り出す（繰り返しの予定・その回だけ変えた予定・取り消しにも対応）
function calendarEvents(ics, from, to) {
  const root = new ICAL.Component(ICAL.parse(ics));
  root.getAllSubcomponents('vtimezone').forEach(tz => ICAL.TimezoneService.register(tz));
  const masters = {}, exceptions = [];
  root.getAllSubcomponents('vevent').forEach(v => {
    const ev = new ICAL.Event(v);
    if (ev.isRecurrenceException()) exceptions.push(ev); else masters[ev.uid] = ev;
  });
  exceptions.forEach(ex => masters[ex.uid] ? masters[ex.uid].relateException(ex) : (masters[ex.uid + ex.recurrenceId] = ex));

  const out = [];
  const add = (item, start, key) => {
    const date = icalDate(start);
    if (date < from || date > to || item.component.getFirstPropertyValue('status') === 'CANCELLED') return;
    out.push({ key, date, title: item.summary || '（無題の予定）', time: start.isDate ? '' : hm(start.toJSDate()) });
  };
  for (const ev of Object.values(masters)) {
    if (!ev.isRecurring()) { add(ev, ev.startDate, ev.uid); continue; }
    const it = ev.iterator();
    for (let next, n = 0; (next = it.next()) && n < 100000; n++) {
      if (icalDate(next) > shift(to, 1)) break;
      const d = ev.getOccurrenceDetails(next);
      add(d.item, d.startDate, ev.uid + '|' + next.toString());
    }
  }
  return out;
}

async function syncCalendar(force) {
  if (!sb || !session || calSyncing || (!force && Date.now() - calSyncedAt < CAL_INTERVAL)) return;
  calSyncing = true;
  calSyncedAt = Date.now();
  try {
    const { data, error } = await sb.functions.invoke('calendar', { body: {} });
    if (error) throw error;
    if (data.error) throw new Error(data.error);
    if (!data.ics) return 0;
    if (!/^BEGIN:VCALENDAR/.test(data.ics.trim())) throw new Error('カレンダーの中身を読めませんでした');
    await loadScript(ICAL_LIB);
    const today = todayStr(), last = shift(today, CAL_DAYS - 1);
    // 変更・削除を見分けるため、取り込む範囲より広く読んでおく（遠くへ動かした予定を「消えた」と思わないように）
    const events = calendarEvents(data.ics, shift(today, -31), shift(today, 400));
    const byKey = new Map(events.map(e => [e.key, e]));
    const { data: rows, error: rowsErr } = await sb.from('calendar_imports').select('key,task_id,title,date,time,gone');
    if (rowsErr) throw rowsErr;
    const known = new Set(rows.map(r => r.key));
    const snap = (e, taskId) => ({ user_id: userId(), key: e.key, task_id: taskId, title: e.title, date: e.date, time: e.time, gone: false });
    const ops = [], rowUpdates = [];
    let added = 0;

    // 新しい予定 → タスクにする。記録のない予定だけが返ってくる（ほかの端末が先に入れた予定は返ってこない）
    const fresh = events.filter(e => e.date >= today && e.date <= last && !known.has(e.key)).map(e => ({ e, id: uid() }));
    if (fresh.length) {
      const res = await sb.from('calendar_imports')
        .upsert(fresh.map(f => snap(f.e, f.id)), { onConflict: 'user_id,key', ignoreDuplicates: true })
        .select('key');
      if (res.error) throw res.error;
      const ok = new Set(res.data.map(r => r.key));
      const tasks = fresh.filter(f => ok.has(f.e.key)).map(f => ({
        id: f.id, title: f.e.title, date: f.e.date, time: f.e.time, priority: 'mid', tag: '📅',
        due: '', goalId: null, done: false, doneAt: null, createdAt: Date.now()
      }));
      state.tasks.push(...tasks);
      if (tasks.length) ops.push({ t: 'upsert', table: 'tasks', row: tasks.map(taskRow) });
      added = tasks.length;
    }

    // 前に入れた予定 → カレンダー側で変わっていたらタスクも直し、消えていたらタスクも消す（完了済みは触らない）
    const linked = new Set(rows.map(r => r.task_id).filter(Boolean));
    for (const r of rows) {
      const e = byKey.get(r.key);
      if (!r.task_id) {
        // 記録を始める前に入れた予定：同じ名前・日時の 📅 タスクを探してつなぐ（もう無い予定は追わない）
        if (!e) { if (!r.gone) rowUpdates.push({ ...r, user_id: userId(), gone: true }); continue; }
        const t = state.tasks.find(t => t.tag === '📅' && !linked.has(t.id) && t.title === e.title && t.date === e.date && (t.time || '') === e.time);
        if (t) linked.add(t.id);
        rowUpdates.push(snap(e, t ? t.id : null));
        continue;
      }
      const t = state.tasks.find(t => t.id === r.task_id);
      if (e && (r.gone || r.title !== e.title || r.date !== e.date || (r.time || '') !== e.time)) {
        if (t && !t.done) {
          Object.assign(t, { title: e.title, date: e.date, time: e.time });
          ops.push({ t: 'upsert', table: 'tasks', row: taskRow(t) });
        }
        rowUpdates.push(snap(e, r.task_id));
      } else if (!e && events.length && !r.gone && r.date >= today) {
        if (t && !t.done) {
          state.tasks = state.tasks.filter(x => x !== t);
          ops.push({ t: 'delete', table: 'tasks', match: { id: t.id } });
        }
        rowUpdates.push({ ...r, user_id: userId(), gone: true });
      }
    }
    if (rowUpdates.length) {
      const res = await sb.from('calendar_imports').upsert(rowUpdates, { onConflict: 'user_id,key' });
      if (res.error) throw res.error;
    }
    if (ops.length) commit(ops);
    return added;
  } catch (e) {
    console.warn('カレンダーを取り込めませんでした', e);
    if (force) throw e;
  } finally {
    calSyncing = false;
  }
}

async function loadCalendar() {
  $('calBox').hidden = !session;
  if (!session) return;
  const { data, error } = await sb.from('calendar_settings').select('ical_url').maybeSingle();
  if (error) { calMsg('まだ準備ができていません（Supabase で SQL を実行してください）。'); return; }
  $('calUrl').value = data ? data.ical_url : '';
  $('calRemove').hidden = !data;
  calMsg(data ? 'つながっています。アプリを開いたときと 10 分ごとに予定を取り込みます。'
    : 'Google カレンダーの設定にある「非公開の iCal 形式のアドレス」を貼ってください。');
}
$('calSave').onclick = async () => {
  const url = $('calUrl').value.trim();
  if (!/^https:\/\/calendar\.google\.com\/.+\.ics$/.test(url)) { calMsg('「https://calendar.google.com/」で始まり「.ics」で終わるアドレスを貼ってください。'); return; }
  $('calSave').disabled = true;
  calMsg('読み込み中…');
  try {
    const { error } = await sb.from('calendar_settings').upsert({ user_id: userId(), ical_url: url, updated_at: new Date().toISOString() });
    if (error) throw error;
    const n = await syncCalendar(true);
    await loadCalendar();
    calMsg(`つながりました。${n ? `予定を ${n} 件タスクに入れました。` : '新しく入れる予定はありませんでした。'}`);
  } catch (err) {
    calMsg('エラー：' + (err.message || err));
  } finally {
    $('calSave').disabled = false;
  }
};
$('calRemove').onclick = async () => {
  if (!confirm('Google カレンダーとつなぐのをやめますか？\n（もう入ったタスクはそのまま残ります）')) return;
  const { error } = await sb.from('calendar_settings').delete().eq('user_id', userId());
  if (error) calMsg('エラー：' + error.message); else loadCalendar();
};

// ---------- Claude 用の合言葉 ----------
// 合言葉そのものは保存せず、SHA-256 にした値だけをサーバーに置く。表示は作った直後の 1 回だけ
async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function loadAiToken() {
  $('aiBox').hidden = !session;
  $('aiTokenOut').hidden = true;
  if (!session) return;
  const { data, error } = await sb.from('ai_tokens').select('created_at').order('created_at', { ascending: false }).limit(1);
  if (error) { $('aiTokenMsg').textContent = 'まだ準備ができていません（Supabase で SQL を実行してください）。'; $('aiTokenBtn').disabled = true; return; }
  $('aiTokenBtn').disabled = false;
  const made = data && data[0] && new Date(data[0].created_at);
  $('aiTokenBtn').textContent = made ? '合言葉を作り直す' : '合言葉を作る';
  $('aiTokenMsg').textContent = made
    ? `合言葉は ${made.getMonth() + 1}/${made.getDate()} に作ってあります。作り直すと、前の合言葉は使えなくなります。`
    : '作った合言葉を、claude.ai のネットワークシークレットに登録します。';
}
$('aiTokenBtn').onclick = async () => {
  if ($('aiTokenBtn').textContent.includes('作り直す') && !confirm('合言葉を作り直しますか？\nclaude.ai に登録した合言葉も入れかえる必要があります。')) return;
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = 'ai_' + btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const del = await sb.from('ai_tokens').delete().eq('user_id', userId());
  const ins = del.error ? del : await sb.from('ai_tokens').insert({ token_hash: await sha256Hex(token), user_id: userId() });
  if (ins.error) { $('aiTokenMsg').textContent = '作れませんでした：' + ins.error.message; return; }
  $('aiTokenOut').value = token;
  $('aiTokenOut').hidden = false;
  $('aiTokenOut').select();
  const ok = await copyText(token);
  $('aiTokenBtn').textContent = '合言葉を作り直す';
  $('aiTokenMsg').textContent = (ok ? 'コピーしました。' : '上の合言葉を選んでコピーしてください。')
    + 'この合言葉は今だけ表示されます。claude.ai に登録したら、ほかの場所には貼らないでください。';
};

// ---------- 毎朝の通知（Web Push） ----------
const pushReady = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent);
let pushSub = null;   // この端末の通知の登録
let vapidKey = null;  // 通知を送るサーバーの公開鍵（Edge Function から受け取る）

function notifyMsg(text) { $('notifyMsg').textContent = text; }
function b64ToBytes(s) {
  const b = atob((s + '='.repeat((4 - s.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(b, c => c.charCodeAt(0));
}
async function loadNotify() {
  $('notifyBox').hidden = !session;
  if (!session) return;
  $('notifyToggle').disabled = !pushReady;
  if (!pushReady) {
    notifyMsg(isIOS ? 'iPhone では、ホーム画面に追加したアプリから開くと通知をオンにできます。' : 'このブラウザは通知に対応していません。');
    return;
  }
  const { data } = await sb.from('notify_settings').select('morning_time,remind_times').maybeSingle();
  if (data) {
    $('notifyTime').value = data.morning_time;
    $('notifyRemind').checked = (data.remind_times || []).length > 0;
  }
  const reg = await navigator.serviceWorker.getRegistration();
  pushSub = reg ? await reg.pushManager.getSubscription() : null;
  $('notifyToggle').textContent = pushSub ? 'この端末の通知をオフにする' : 'この端末で通知をオンにする';
  $('notifyTest').hidden = !pushSub;
  const remind = $('notifyRemind').checked ? '12:00 と 18:00 には終わっていないタスクも' : '';
  notifyMsg(pushSub
    ? `この端末に、毎朝 ${$('notifyTime').value} ごろ今日の予定が届きます。${remind && remind + '届きます。'}`
    : 'オンにすると、毎朝決めた時刻に今日のタスクと習慣が届きます。');
  // iPhone では許可を求めたあとすぐ登録しないと失敗することがあるので、鍵は先にもらっておく
  if (!pushSub && !vapidKey) {
    const res = await sb.functions.invoke('push', { body: { action: 'key' } });
    if (res.data && res.data.publicKey) vapidKey = res.data.publicKey;
  }
}
function saveNotifyTime() {
  return sb.from('notify_settings').upsert({
    user_id: userId(), morning_time: $('notifyTime').value || '07:00',
    remind_times: $('notifyRemind').checked ? ['12:00', '18:00'] : [],
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Tokyo'
  });
}
for (const id of ['notifyTime', 'notifyRemind']) $(id).addEventListener('change', async () => {
  const { error } = await saveNotifyTime();
  if (error) notifyMsg('設定を保存できませんでした：' + error.message);
  else loadNotify();
});
$('notifyToggle').onclick = async () => {
  $('notifyToggle').disabled = true;
  try {
    if (pushSub) {
      await sb.from('push_subscriptions').delete().eq('endpoint', pushSub.endpoint);
      await pushSub.unsubscribe();
    } else {
      if (await Notification.requestPermission() !== 'granted') {
        notifyMsg('通知が許可されていません。iPhone の「設定」→「通知」→「毎日のタスク」から許可できます。');
        return;
      }
      if (!vapidKey) throw new Error('通知の準備がまだできていません（Edge Function「push」が動いていないかもしれません）');
      const reg = await navigator.serviceWorker.ready;
      const sub = (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(vapidKey) })).toJSON();
      const res = await sb.from('push_subscriptions').upsert({ endpoint: sub.endpoint, user_id: userId(), p256dh: sub.keys.p256dh, auth: sub.keys.auth });
      if (res.error) throw res.error;
      const res2 = await saveNotifyTime();
      if (res2.error) throw res2.error;
    }
    await loadNotify();
  } catch (err) {
    notifyMsg('エラー：' + (err.message || err));
  } finally {
    $('notifyToggle').disabled = false;
  }
};
$('notifyTest').onclick = async () => {
  notifyMsg('送信中…');
  const { data, error } = await sb.functions.invoke('push', { body: { action: 'test' } });
  notifyMsg(error ? 'エラー：' + error.message
    : data.sent ? 'テスト通知を送りました。数秒で届きます。' : '送り先の端末が見つかりませんでした。通知をオンにし直してください。');
};

// ---------- ログイン ----------
// 新規登録は Supabase 側で止めてあるので、ログインだけ
function authMsg(text, isErr) {
  $('authMsg').textContent = text;
  $('authMsg').className = isErr ? 'err' : 'muted';
}
$('authForm').addEventListener('submit', async e => {
  e.preventDefault();
  const email = $('authEmail').value.trim(), password = $('authPass').value;
  $('authSubmit').disabled = true;
  authMsg('通信中…');
  try {
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
  } catch (err) {
    const m = err.message || '';
    authMsg(
      /Invalid login/i.test(m) ? 'メールアドレスかパスワードが違います' :
      /not confirmed/i.test(m) ? 'メールの確認がまだです。届いたメールのリンクを押してください' :
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
function showAuth() { $('app').hidden = true; $('auth').hidden = false; authMsg(''); }

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
