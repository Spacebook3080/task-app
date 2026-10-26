// 毎朝のまとめを Web Push で送る Supabase Edge Function「push」
// Supabase の画面（Edge Functions → Deploy a new function → Via Editor）で、名前を push にしてこのファイルを貼り付ける。
// 「Verify JWT」はオフにする（5 分ごとに呼ぶ pg_cron がログインせずに呼ぶため）。
//
// 受け付ける呼び出し（POST の JSON）:
//   { action: 'key' }  … 通知の登録に使う公開鍵を返す（鍵がなければ作る）
//   { action: 'test' } … ログイン中の本人の端末に、今すぐまとめを送る
//   { action: 'cron' } … 各ユーザーの決めた時刻になっていれば、その日のまとめを 1 回だけ送る
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import webpush from 'npm:web-push@3.6.7';

const APP_URL = 'https://spacebook3080.github.io/task-app/';
const PRI_ORDER: Record<string, number> = { high: 0, mid: 1, low: 2 };
const WEEK_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const LATE_LIMIT = 120; // 決めた時刻から何分過ぎるまでなら送るか（それ以降はその日は送らない）

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}
function toMin(hm: string) { const [h, m] = hm.split(':').map(Number); return h * 60 + m; }

// その人のタイムゾーンでの今日の日付・時刻・曜日
function localNow(tz: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23'
  }).formatToParts(new Date()).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, wd: WEEK_EN.indexOf(p.weekday) };
}

// 通知を送るための鍵。初回だけ作って push_keys に保存する
async function loadVapid() {
  let { data } = await admin.from('push_keys').select('public_key,private_key').eq('id', 1).maybeSingle();
  if (!data) {
    const k = webpush.generateVAPIDKeys();
    await admin.from('push_keys').upsert({ id: 1, public_key: k.publicKey, private_key: k.privateKey }, { onConflict: 'id', ignoreDuplicates: true });
    ({ data } = await admin.from('push_keys').select('public_key,private_key').eq('id', 1).single());
  }
  webpush.setVapidDetails(APP_URL, data!.public_key, data!.private_key);
  return data!.public_key as string;
}

// 今日のまとめの文面（未完了のタスク＝今日の分と持ち越し、今日の曜日の習慣）
async function summary(userId: string, now: ReturnType<typeof localNow>) {
  const [tasksRes, routinesRes] = await Promise.all([
    admin.from('tasks').select('title,date,time,priority,created_at').eq('user_id', userId).eq('done', false).lte('date', now.date),
    admin.from('routines').select('title,days').eq('user_id', userId)
  ]);
  const tasks = (tasksRes.data ?? []).sort((a, b) =>
    (PRI_ORDER[a.priority] - PRI_ORDER[b.priority]) ||
    (a.time || '99').localeCompare(b.time || '99') ||
    a.created_at.localeCompare(b.created_at));
  const carried = tasks.filter(t => t.date < now.date).length;
  const habits = (routinesRes.data ?? []).filter(r => (r.days ?? []).includes(now.wd));

  if (!tasks.length && !habits.length) return '今日の予定はまだありません。やることを書き出してみましょう。';
  const lines = [`タスク ${tasks.length}件${carried ? `（持ち越し ${carried}件）` : ''}・習慣 ${habits.length}件`];
  for (const t of tasks.slice(0, 4)) lines.push(`・${t.time ? t.time + ' ' : ''}${t.title}`);
  if (tasks.length > 4) lines.push(`ほか ${tasks.length - 4}件`);
  return lines.join('\n');
}

// その人の登録済みの端末すべてに送る。もう使われていない登録は消す
async function send(userId: string, title: string, body: string) {
  const { data: subs } = await admin.from('push_subscriptions').select('endpoint,p256dh,auth').eq('user_id', userId);
  let sent = 0;
  for (const s of subs ?? []) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify({ title, body, url: APP_URL }),
        { TTL: 60 * 60 * 3 });
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
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const { action = 'cron' } = await req.json().catch(() => ({}));
    const publicKey = await loadVapid();

    if (action === 'key') return json({ publicKey });

    if (action === 'test') {
      const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
      const { data: { user } } = await admin.auth.getUser(token);
      if (!user) return json({ error: 'ログインが必要です' }, 401);
      const { data: set } = await admin.from('notify_settings').select('tz').eq('user_id', user.id).maybeSingle();
      const sent = await send(user.id, '🔔 テスト通知', await summary(user.id, localNow(set?.tz || 'Asia/Tokyo')));
      return json({ sent });
    }

    // cron：決めた時刻を過ぎていて、今日まだ送っていない人に送る
    const { data: rows } = await admin.from('notify_settings').select('user_id,morning_time,tz,last_sent');
    let users = 0;
    for (const r of rows ?? []) {
      const now = localNow(r.tz || 'Asia/Tokyo');
      const late = toMin(now.time) - toMin(r.morning_time);
      if (late < 0 || late > LATE_LIMIT || r.last_sent === now.date) continue;
      // 先に「今日は送った」と書いておき、同時に呼ばれても二重に送らないようにする
      const { data: claimed } = await admin.from('notify_settings').update({ last_sent: now.date })
        .eq('user_id', r.user_id).or(`last_sent.is.null,last_sent.neq.${now.date}`).select('user_id');
      if (!claimed?.length) continue;
      await send(r.user_id, '☀ おはようございます', await summary(r.user_id, now));
      users++;
    }
    return json({ users });
  } catch (e) {
    console.error(e);
    return json({ error: String((e as Error).message || e) }, 500);
  }
});
