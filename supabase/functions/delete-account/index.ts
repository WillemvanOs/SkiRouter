// Delete the signed-in user's account and everything kept with it (profile,
// saved days; payments too, by cascade). The right to erasure (GDPR art. 17).
// Bookkeeping: export the payments you must keep for the tax office first,
// or keep them elsewhere (Mollie keeps its own records of every payment).

import { admin, cors, json, signedInUser } from '../_shared/http.ts';

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const user = await signedInUser(req);
  if (!user) return json({ error: 'Sign in first.' }, 401);

  const { error } = await admin().auth.admin.deleteUser(user.id);
  if (error) return json({ error: 'Could not delete the account.' }, 500);
  return json({ deleted: true });
});
