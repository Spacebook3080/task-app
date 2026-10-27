// Google カレンダーの「非公開の iCal アドレス」を、アプリの代わりに読みに行く Edge Function「calendar」
// （Google はブラウザから直接読ませてくれないため、ここを経由する。予定をタスクにするのはアプリ側）
// Supabase の画面（Edge Functions → Deploy a new function → Via Editor）で、名前を calendar にしてこのファイルを貼り付ける。
// 「Verify JWT」はオンのままでよい（ログイン中のアプリからだけ呼ぶため）。
//
// 受け付ける呼び出し（POST）: ログイン中の本人の calendar_settings.ical_url を読み、{ ics: '<iCal の中身>' } を返す
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const { data: { user } } = await admin.auth.getUser(token);
    if (!user) return json({ error: 'ログインが必要です' }, 401);

    const { data: set } = await admin.from('calendar_settings').select('ical_url').eq('user_id', user.id).maybeSingle();
    if (!set?.ical_url) return json({ ics: null });
    // Google カレンダー以外の場所には取りに行かない
    const url = new URL(set.ical_url);
    if (url.protocol !== 'https:' || url.hostname !== 'calendar.google.com') return json({ error: 'Google カレンダーのアドレスではありません' }, 400);

    const res = await fetch(url);
    if (!res.ok) return json({ error: `カレンダーを読めませんでした（${res.status}）。アドレスが変わっていないか確認してください` }, 502);
    return json({ ics: await res.text() });
  } catch (e) {
    console.error(e);
    return json({ error: String((e as Error).message || e) }, 500);
  }
});
