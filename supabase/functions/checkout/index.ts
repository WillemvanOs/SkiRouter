// Start paying for a season pass: makes a Mollie payment for the signed-in
// user and answers with the checkout page to send them to. Mollie calls
// mollie-webhook when the payment's status changes; only that grants the pass.

import { admin, APP_URL, cors, json, mollie, signedInUser } from '../_shared/http.ts';
import { currentSeason, seasonPrice } from '../_shared/season.ts';

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const user = await signedInUser(req);
  if (!user) return json({ error: 'Sign in first.' }, 401);

  const db = admin();
  const { data: settings } = await db.from('app_settings').select('payments_on').single();
  if (!settings?.payments_on) return json({ error: 'There is nothing to pay while SkiRouter is being tested.' }, 409);
  const season = currentSeason();
  const { data: profile } = await db.from('profiles').select('paid_until').eq('id', user.id).single();
  if (profile?.paid_until && new Date(profile.paid_until) >= season.until) {
    return json({ error: `You already have the season pass for ${season.label}.` }, 409);
  }

  const amount = seasonPrice();
  const payment = await mollie('payments', {
    method: 'POST',
    body: JSON.stringify({
      amount: { currency: 'EUR', value: amount },
      description: `SkiRouter season pass ${season.label}`,
      redirectUrl: `${APP_URL}/index.html?paid=1`, // the app's own page, inside its scope (manifest)
      webhookUrl: `${Deno.env.get('SUPABASE_URL')}/functions/v1/mollie-webhook`,
      metadata: { user_id: user.id, season: season.label },
    }),
  });

  const { error } = await db.from('payments').insert({
    id: payment.id, user_id: user.id, season: season.label, amount: Number(amount), status: payment.status,
  });
  if (error) return json({ error: 'Could not start the payment.' }, 500);

  return json({ checkoutUrl: payment._links.checkout.href });
});
