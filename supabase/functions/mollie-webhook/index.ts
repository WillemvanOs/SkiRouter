// Mollie calls this with only a payment id whenever a payment's status
// changes. Never trust the call itself: the status is fetched from Mollie
// with our own key, so a forged call can at most make us look one up.
//
// Deployed with --no-verify-jwt (Mollie sends no Supabase token).

import { admin, mollie } from '../_shared/http.ts';
import { currentSeason } from '../_shared/season.ts';

Deno.serve(async req => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const form = await req.formData().catch(() => null);
  const id = String(form?.get('id') || '');
  if (!/^tr_[A-Za-z0-9]+$/.test(id)) return new Response('Bad request', { status: 400 });

  const db = admin();
  const { data: row } = await db.from('payments').select('user_id, season, status').eq('id', id).single();
  // Not one of ours: answer 200 so Mollie stops retrying, without saying more.
  if (!row) return new Response('ok');

  let payment;
  try {
    payment = await mollie(`payments/${id}`);
  } catch (err) {
    console.error(err);
    return new Response('Try again', { status: 502 }); // Mollie retries
  }
  if (payment.metadata?.user_id !== row.user_id) return new Response('ok');

  await db.from('payments').update({
    status: payment.status,
    paid_at: payment.paidAt || null,
  }).eq('id', id);

  if (payment.status === 'paid' && row.status !== 'paid') {
    // The season the payment was for, valid until that season's end; a pass
    // already running longer stays as it is.
    const paidAt = new Date(payment.paidAt || Date.now());
    const season = currentSeason(paidAt);
    const { data: profile } = await db.from('profiles').select('paid_until').eq('id', row.user_id).single();
    const until = profile?.paid_until && new Date(profile.paid_until) > season.until ? new Date(profile.paid_until) : season.until;
    const { error } = await db.from('profiles').update({ paid_until: until.toISOString() }).eq('id', row.user_id);
    if (error) {
      console.error(error);
      return new Response('Try again', { status: 500 });
    }
  }
  return new Response('ok');
});
