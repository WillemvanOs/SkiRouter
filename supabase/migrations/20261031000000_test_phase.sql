-- Test phase: accounts without payment. While app_settings.payments_on is
-- false, every signed-in account counts as having the season pass, so saving
-- days works for everyone who is signed in, and the checkout function refuses
-- to start a payment. Once Mollie is set up:
--
--   update public.app_settings set payments_on = true;
--
-- (Supabase → SQL editor) together with payments: true in config.js.

create table public.app_settings (
  id           boolean primary key default true check (id), -- one row only
  payments_on  boolean not null default false
);

insert into public.app_settings (id, payments_on) values (true, false);

-- Read by the functions below (security definer) and the Edge Functions
-- (service role); nobody else reads or changes it.
alter table public.app_settings enable row level security;
revoke all on public.app_settings from anon, authenticated;

create or replace function public.has_season_pass() returns boolean
language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and (
    not coalesce((select payments_on from public.app_settings), false)
    or exists (
      select 1 from public.profiles
      where id = auth.uid() and paid_until > now()
    )
  );
$$;
