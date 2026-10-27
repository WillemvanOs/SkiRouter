// The season pass: one payment per winter season, valid until the end of
// June. From May on a pass is for the coming season (bought in May 2027: the
// 2027/28 season, until 30 June 2028).

export function currentSeason(now = new Date()): { label: string; until: Date } {
  const year = now.getUTCMonth() >= 4 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  return {
    label: `${year}/${String((year + 1) % 100).padStart(2, '0')}`,
    until: new Date(Date.UTC(year + 1, 6, 1)), // 1 July, 00:00 UTC
  };
}

export function seasonPrice(): string {
  const price = Number(Deno.env.get('SEASON_PRICE') || '9.99');
  return price.toFixed(2); // Mollie wants "9.99"
}
