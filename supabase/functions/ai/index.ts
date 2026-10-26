// Claude（スケジュールタスク）がアプリのデータを読み書きするための窓口 Edge Function「ai」
// Supabase の画面（Edge Functions → Deploy a new function → Via Editor）で、名前を ai にしてこのファイルを貼り付ける。
// 「Verify JWT」はオフにする（Claude はログインせず、アプリで作った合言葉で呼ぶため）。
//
// 合言葉は「Authorization: Bearer <合言葉>」で受け取る。できることは次の 2 つだけ:
//   { action: 'week' } … 今日までの 7 日間の記録（目標・終えたタスク・習慣・メモ）を返す
//   { action: 'post', body, steps, period_end } … 振り返りの文とステップ案を「Claude から」の便りとして保存し、通知する
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import webpush from 'npm:web-push@3.6.7';

const APP_URL = 'https://spacebook3080.github.io/task-app/';
const MAX_BODY = 6000;  // 振り返りの文の最大文字数
const MAX_STEPS = 20;   // ステップ案の最大数

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 1), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}
async function sha256(s: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
// その人のタイムゾーンでの今日の日付
function localToday(tz: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date()).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
function shift(date: string, n: number) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// 今日までの 7 日間の記録
async function week(userId: string) {
  const { data: set } = await admin.from('notify_settings').select('tz').eq('user_id', userId).maybeSingle();
  const tz = set?.tz || 'Asia/Tokyo';
  const today = localToday(tz), start = shift(today, -6);
  const [goals, tasks, routines, logs, notes, last] = await Promise.all([
    admin.from('goals').select('id,parent_id,title,deadline,done,done_at,created_at').eq('user_id', userId).order('created_at'),
    admin.from('tasks').select('title,date,done,done_at,goal_id').eq('user_id', userId).gte('date', shift(today, -30)),
    admin.from('routines').select('id,title,days').eq('user_id', userId),
    admin.from('routine_logs').select('routine_id,date').eq('user_id', userId).gte('date', start).lte('date', today),
    admin.from('notes').select('date,body').eq('user_id', userId).gte('date', shift(today, -13)).lte('date', today).order('date'),
    admin.from('ai_messages').select('period_end,body').eq('user_id', userId).order('created_at', { ascending: false }).limit(1)
  ]);
  const doneIn = (t: { done: boolean, date: string }) => t.done && t.date >= start && t.date <= today;
  return {
    説明: '今日までの 7 日間の記録。goals は parent_id でつながるツリーで、parent_id が null のものがビジョン、その下が目標、さらに下がステップ。進み具合はいちばん下のステップの完了数で測る',
    timezone: tz, today, week_start: start,
    goals: goals.data ?? [],
    tasks_done_this_week: (tasks.data ?? []).filter(doneIn),
    tasks_open_until_today: (tasks.data ?? []).filter(t => !t.done && t.date <= today).map(t => ({ title: t.title, date: t.date, goal_id: t.goal_id })),
    routines: (routines.data ?? []).map(r => {
      const planned: string[] = [];
      for (let d = start; d <= today; d = shift(d, 1)) if ((r.days ?? []).includes(new Date(d + 'T00:00:00Z').getUTCDay())) planned.push(d);
      const done = (logs.data ?? []).filter(l => l.routine_id === r.id).map(l => l.date);
      return { title: r.title, planned_days: planned.length, done_days: done.length, done_dates: done };
    }),
    notes_last_14_days: notes.data ?? [],
    last_claude_message: last.data?.[0] ?? null
  };
}

// その人の登録済みの端末すべてに通知する（push 関数と同じ鍵を使う）
async function notify(userId: string, title: string, body: string) {
  const { data: key } = await admin.from('push_keys').select('public_key,private_key').eq('id', 1).maybeSingle();
  if (!key) return 0;
  webpush.setVapidDetails(APP_URL, key.public_key, key.private_key);
  const { data: subs } = await admin.from('push_subscriptions').select('endpoint,p256dh,auth').eq('user_id', userId);
  let sent = 0;
  for (const s of subs ?? []) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify({ title, body, url: APP_URL }), { TTL: 60 * 60 * 24 });
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await admin.from('push_subscriptions').delete().eq('endpoint', s.endpoint);
      else console.error('send failed', code, e);
    }
  }
  return sent;
}

Deno.serve(async req => {
  try {
    if (req.method !== 'POST') return json({ error: 'POST で呼んでください' }, 405);
    const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
    if (!token) return json({ error: '合言葉がありません（Authorization: Bearer）' }, 401);
    const { data: owner } = await admin.from('ai_tokens').select('user_id').eq('token_hash', await sha256(token)).maybeSingle();
    if (!owner) return json({ error: '合言葉が違います。アプリの設定で作り直してください' }, 401);
    const userId = owner.user_id as string;

    const input = await req.json().catch(() => ({}));
    if (input.action === 'week') return json(await week(userId));

    if (input.action === 'post') {
      const body = String(input.body || '').trim();
      if (!body) return json({ error: 'body（振り返りの文）が空です' }, 400);
      if (body.length > MAX_BODY) return json({ error: `body は ${MAX_BODY} 文字までにしてください` }, 400);
      // ステップ案は、本人の目標の下に入るものだけ受け付ける
      const { data: goals } = await admin.from('goals').select('id').eq('user_id', userId);
      const ids = new Set((goals ?? []).map(g => g.id));
      const raw = Array.isArray(input.steps) ? input.steps : [];
      const steps = raw.slice(0, MAX_STEPS)
        .map((s: { parent_id?: unknown, title?: unknown }) => ({ parent_id: String(s?.parent_id || ''), title: String(s?.title || '').trim().slice(0, 200), added: false }))
        .filter((s: { parent_id: string, title: string }) => s.title && ids.has(s.parent_id));
      const period = /^\d{4}-\d{2}-\d{2}$/.test(input.period_end || '') ? input.period_end : null;
      const { data: row, error } = await admin.from('ai_messages')
        .insert({ user_id: userId, kind: 'review', period_end: period, body, steps }).select('id').single();
      if (error) throw error;
      const sent = await notify(userId, '🤖 Claude から週の振り返りが届きました', body.replace(/\s+/g, ' ').slice(0, 80));
      return json({ ok: true, id: row.id, steps_saved: steps.length, steps_ignored: raw.length - steps.length, notified: sent });
    }

    return json({ error: 'action は week か post にしてください' }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: String((e as Error).message || e) }, 500);
  }
});
