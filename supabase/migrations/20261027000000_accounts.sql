-- Accounts for SkiRouter: a profile per user (birth date, country, the
-- preferences the app keeps), the season pass, payments and saved day plans.
--
-- Who may do what is enforced here with row level security, not in the app:
-- everyone reads and changes only their own rows; the season pass and the
-- payments are written by the Edge Functions alone (service role), after
-- Mollie confirms a payment; saving a day plan needs a valid season pass.

-- ── Profiles ────────────────────────────────────────────────────────────────

create table public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  birthdate   date not null,
  country     text not null check (country ~ '^[A-Z]{2}$'),
  prefs       jsonb not null default '{}'::jsonb,
  paid_until  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- 16 and over: younger users need a parent's consent under the GDPR (art. 8).
  constraint profiles_min_age check (birthdate <= (created_at at time zone 'UTC')::date - interval '16 years'),
  constraint profiles_birthdate_sane check (birthdate >= date '1900-01-01'),
  constraint profiles_prefs_size check (pg_column_size(prefs) < 65536)
);

alter table public.profiles enable row level security;

create policy "Own profile: read" on public.profiles
  for select using (auth.uid() = id);

create policy "Own profile: update" on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);

-- Users may change their preferences, country and birth date, never their
-- season pass (paid_until) or the timestamps.
revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;
grant update (prefs, country, birthdate) on public.profiles to authenticated;

create function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();

-- Signing up (supabase.auth.signUp with data: { birthdate, country }) makes
-- the profile in the same transaction: a sign-up without a valid birth date
-- or country, or under 16, fails as a whole.
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, birthdate, country)
  values (
    new.id,
    (new.raw_user_meta_data ->> 'birthdate')::date,
    upper(new.raw_user_meta_data ->> 'country')
  );
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ── Season pass ─────────────────────────────────────────────────────────────

create function public.has_season_pass() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and paid_until > now()
  );
$$;

-- ── Payments (Mollie) ───────────────────────────────────────────────────────

create table public.payments (
  id          text primary key,              -- Mollie's payment id (tr_…)
  user_id     uuid not null references auth.users (id) on delete cascade,
  season      text not null,                 -- '2026/27'
  amount      numeric(10, 2) not null,
  currency    text not null default 'EUR',
  status      text not null default 'open',  -- Mollie's status: open, paid, failed, canceled, expired
  created_at  timestamptz not null default now(),
  paid_at     timestamptz
);

create index payments_user on public.payments (user_id);

alter table public.payments enable row level security;

create policy "Own payments: read" on public.payments
  for select using (auth.uid() = user_id);

revoke all on public.payments from anon, authenticated;
grant select on public.payments to authenticated;

-- ── Saved day plans ─────────────────────────────────────────────────────────
--
-- What the day planner needs to plan the day again (start, end, times, km,
-- stops, lunch, pace, difficulties) plus a summary for the list. Planning is
-- seeded, so the same inputs give the same day while the area's lifts and
-- pistes stay the same.

create table public.routes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  area_id     text not null check (length(area_id) between 1 and 200),
  area_name   text not null check (length(area_name) between 1 and 200),
  name        text not null check (length(name) between 1 and 100),
  inputs      jsonb not null check (pg_column_size(inputs) < 16384),
  option      smallint not null default 0 check (option between 0 and 9),
  summary     jsonb not null default '{}'::jsonb check (pg_column_size(summary) < 4096),
  created_at  timestamptz not null default now()
);

create index routes_user on public.routes (user_id, created_at desc);

alter table public.routes enable row level security;

create policy "Own routes: read" on public.routes
  for select using (auth.uid() = user_id);

create policy "Own routes: save with a season pass" on public.routes
  for insert with check (auth.uid() = user_id and public.has_season_pass());

create policy "Own routes: rename with a season pass" on public.routes
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id and public.has_season_pass());

-- Deleting stays possible after the pass ends.
create policy "Own routes: delete" on public.routes
  for delete using (auth.uid() = user_id);

revoke all on public.routes from anon, authenticated;
grant select, insert, delete on public.routes to authenticated;
grant update (name) on public.routes to authenticated;

-- At most 200 saved days per user.
create function public.routes_limit() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select count(*) from public.routes where user_id = new.user_id) >= 200 then
    raise exception 'You can save up to 200 days. Delete one first.';
  end if;
  return new;
end $$;

create trigger routes_limit before insert on public.routes
  for each row execute function public.routes_limit();
