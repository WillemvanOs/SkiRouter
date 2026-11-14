-- Buying the season pass: the buyer asks for it to start at once and accepts
-- losing the 14-day right of withdrawal (EU Consumer Rights Directive, art.
-- 16(m); digital content). The checkout function refuses a payment without
-- that consent and keeps when it was given, as proof.
alter table public.payments add column withdrawal_waived_at timestamptz;
