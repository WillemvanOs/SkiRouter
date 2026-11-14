-- The Edge Functions (service role) read app_settings and write payments and
-- the season pass. Newer Supabase projects no longer grant the service role
-- access to new tables in `public` by default, so the functions could not
-- read app_settings and the checkout answered as if payments were off.
-- Granting is harmless where the access is already there.
grant usage on schema public to service_role;
grant select on public.app_settings to service_role;
grant select, insert, update, delete on public.profiles to service_role;
grant select, insert, update, delete on public.payments to service_role;
grant select, insert, update, delete on public.routes to service_role;
