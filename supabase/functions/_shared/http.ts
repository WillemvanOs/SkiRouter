// What every function needs: CORS for the app's own origin, JSON answers,
// the signed-in user, and a client that may write what users may not.

import { createClient, type SupabaseClient, type User } from 'npm:@supabase/supabase-js@2.118.0';

// The app's address (https://…, no trailing slash): CORS, and where Mollie
// sends the user back after paying.
export const APP_URL = (Deno.env.get('APP_URL') || '').replace(/\/$/, '');

export const cors = {
  'Access-Control-Allow-Origin': APP_URL ? new URL(APP_URL).origin : '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Vary': 'Origin',
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

export function admin(): SupabaseClient {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// The user whose access token came with the request, or null.
export async function signedInUser(req: Request): Promise<User | null> {
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const { data, error } = await admin().auth.getUser(token);
  return error ? null : data.user;
}

export async function mollie(path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`https://api.mollie.com/v2/${path}`, {
    ...init,
    headers: {
      'Authorization': `Bearer ${Deno.env.get('MOLLIE_API_KEY')}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Mollie ${res.status}: ${body.detail || body.title || 'error'}`);
  return body;
}
