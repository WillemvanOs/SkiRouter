// Lift status providers for the European ski areas. Each reads one source
// and returns { lifts: [{ n, open, hours?, text? }], providerUpdate? } with
// the provider's own lift names (the app matches them to our lifts with
// liftmatch.js). A lift whose status the source does not know is left out.
//
//   intermaps  { project: 'https://winter.intermaps.com/obertauern' }  JSON feed of the piste map
//   infosnow   { pid: 31 }                                             infosnow.ch (APG|SGA) page
//   lumiplan   { station: 'risoul' }                                   Lumiplan snow bulletin
//   micado     { base, client, region }                                Micado SkigebieteManager
//
// Used by tools/liftstatus-sources.mjs (which areas have a source) and
// tools/liftstatus-europe.mjs (the status every 30 minutes). Needs cheerio.

import * as cheerio from 'cheerio';

const UA = 'Mozilla/5.0 (compatible; SkiRouter/1.0; +https://github.com/WillemvanOs/SkiRouter)';

export async function get(url, { timeout = 20000, json = false } = {}) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: json ? 'application/json' : 'text/html,*/*' },
      redirect: 'follow', signal: AbortSignal.timeout(timeout),
    });
    return { ok: res.ok, status: res.status, url: res.url, text: await res.text() };
  } catch (err) {
    return { ok: false, status: 0, url, text: '', error: err.message };
  }
}

const fail = page => { throw new Error(page.error || `HTTP ${page.status}`); };

// "08:20 AM" -> "08:20", "3:10 PM" -> "15:10"
function clock(text) {
  const m = /(\d{1,2}):(\d{2})\s*(AM|PM)?/i.exec(text || '');
  if (!m) return null;
  let h = Number(m[1]);
  if (m[3]) h = (h % 12) + (/pm/i.test(m[3]) ? 12 : 0);
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

export const PROVIDERS = {
  async intermaps({ project }) {
    const page = await get(`${project}/data?lang=en`, { json: true });
    if (!page.ok) fail(page);
    const data = JSON.parse(page.text);
    const OPEN = { open: true, closed: false, closed_outoforder: false, in_preparation: false };
    const TEXT = { closed_outoforder: 'out of order', in_preparation: 'in preparation' };
    return {
      providerUpdate: data.lastUpdate || null,
      lifts: (data.lifts || []).map(l => {
        const status = l.status ?? l.popup?.status;
        return { n: (l.popup?.title || l.title || '').trim(), open: OPEN[status], ...(TEXT[status] ? { text: TEXT[status] } : {}) };
      }).filter(l => l.n && typeof l.open === 'boolean'),
    };
  },

  // A .block headed "Lifts (2 from 34 installations in service)", then three
  // cells per lift: status icon (…/data/status/8/1.gif: 1 open, 2 in
  // preparation, 3 closed), type icon, name.
  async infosnow({ pid }) {
    const page = await get(`https://www.infosnow.ch/~apgmontagne/?lang=en&pid=${pid}&tab=web-wi`);
    if (!page.ok) fail(page);
    const $ = cheerio.load(page.text);
    const lifts = [];
    $('.block').each((_, block) => {
      if (!/^\s*Lifts\b/.test($(block).children('h1').text())) return;
      $(block).find('.content img.icon[src*="/data/status/"]').each((_, icon) => {
        const name = $(icon).closest('td').next().next().text().trim();
        const code = (/\/(\d)\.gif$/.exec($(icon).attr('src') || '') || [])[1];
        const open = { 1: true, 2: false, 3: false }[code];
        if (name && open !== undefined) lifts.push({ n: name, open, ...(code === '2' ? { text: 'in preparation' } : {}) });
      });
    });
    return { title: $('title').text().trim(), lifts };
  },

  // One .POI_info per lift: span.nom, .heure ("08:20 AM - 03:10 PM") and a
  // status picture lp_runway_trail_<opened|scheduled|closed|out_period>.svg.
  async lumiplan({ station }) {
    const page = await get(`https://bulletinv3.lumiplan.pro/bulletin.php?station=${encodeURIComponent(station)}&lang=en`);
    if (!page.ok) fail(page);
    const $ = cheerio.load(page.text);
    const lifts = [];
    $('.POI_title').each((_, t) => {
      if (!/lift|remont/i.test($(t).text())) return;
      $(t).next('.liaisons').find('.POI_info').each((_, info) => {
        const n = $(info).find('.nom').first().text().trim();
        const src = $(info).find('img').map((_, i) => $(i).attr('src')).get().find(s => /lp_runway_trail_/.test(s)) || '';
        const state = (/lp_runway_trail_(\w+)\.svg/.exec(src) || [])[1];
        const open = { opened: true, open: true, scheduled: false, closed: false, out_period: false }[state];
        if (!n || open === undefined) return;
        const times = $(info).find('.heure span').map((_, s) => clock($(s).text())).get().filter(Boolean);
        lifts.push({
          n, open,
          ...(times.length === 2 ? { hours: `${times[0]}-${times[1]}` } : {}),
          ...(state === 'scheduled' ? { text: 'opens later today' } : {}),
        });
      });
    });
    return { title: $('title').text().trim(), lifts };
  },

  async micado({ base, client, region }) {
    const params = new URLSearchParams({
      api: 'SkigebieteManager/Micado.SkigebieteManager.Plugin.FacilityApi/ListFacilities.api',
      client, lang: 'de', region, season: 'winter', type: 'lift',
    });
    const page = await get(`${base}/webapi/micadoweb?${params}`, { json: true });
    if (!page.ok) fail(page);
    const data = JSON.parse(page.text);
    const hours = v => { const m = /(\d{1,2}):(\d{2})\s*[-–]\s*(\d{1,2}):(\d{2})/.exec(v || ''); return m ? `${m[1].padStart(2, '0')}:${m[2]}-${m[3].padStart(2, '0')}:${m[4]}` : null; };
    return {
      providerUpdate: data.meta?.lastUpdate || null,
      lifts: (data.facilities || []).map(f => ({
        n: (f.title || f.name || '').trim(), open: f.status === 1,
        ...(hours(f.operatingTimePeriod || f.openingHours) ? { hours: hours(f.operatingTimePeriod || f.openingHours) } : {}),
      })).filter(l => l.n),
    };
  },
};

// A short, stable description of a source, for reports and ids.
export function sourceLabel(s) {
  return s.provider === 'intermaps' ? `intermaps ${s.project.replace(/^https:\/\//, '')}`
    : s.provider === 'infosnow' ? `infosnow pid ${s.pid}`
    : s.provider === 'lumiplan' ? `lumiplan ${s.station}`
    : `micado ${new URL(s.base).hostname} ${s.region}`;
}

// The host to credit in the app ("Lift status from …").
export function sourceHost(s) {
  return s.provider === 'intermaps' ? 'intermaps.com'
    : s.provider === 'infosnow' ? 'infosnow.ch'
    : s.provider === 'lumiplan' ? 'lumiplan.pro'
    : new URL(s.base).hostname.replace(/^www\./, '');
}

export async function readSource(s) {
  const { provider, ...params } = s;
  return PROVIDERS[provider](params);
}
