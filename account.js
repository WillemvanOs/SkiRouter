// Accounts: everyone signs in (email, password, birth date, country); the
// preferences are kept with the account; the day planner and saved days need
// the season pass, paid once per winter through Mollie.
//
// Loaded before app.js. The account itself lives in Supabase (config.js);
// with no project set there, accounts are off and everything is free.
//
// Offline on the mountain: the account last signed in is kept on the phone
// (ACCOUNT_KEY), so the app opens without a connection, season pass and all.
// Preference changes made offline are sent once there is a connection again.

const ACCOUNT_KEY      = 'skirouter:account';
const ACCOUNT_SYNC_KEY = 'skirouter:account-unsynced'; // preferences changed, not yet sent
// The preferences that go with the account: what app.js keeps under these keys.
const SYNCED_KEYS = ['skirouter:prefs', 'skiplanner:favouriteAreas'];
const SYNCED_PREFIXES = ['skiplanner:avoid:', 'skiplanner:avoidpiste:'];
const MIN_AGE = 16; // younger needs a parent's consent (GDPR art. 8)
const SYNC_DELAY_MS = 1500;
const PAID_POLL_MS = 2000, PAID_POLL_TRIES = 15; // after Mollie: until the webhook has run

const accountCfg = window.SKIROUTER_CONFIG || {};
const accountsOn = !!(accountCfg.supabaseUrl && accountCfg.supabaseAnonKey && window.supabase);
const sb = accountsOn ? window.supabase.createClient(accountCfg.supabaseUrl, accountCfg.supabaseAnonKey, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
}) : null;

let account = null; // { id, email, birthdate, country, paid_until }
try { account = JSON.parse(localStorage.getItem(ACCOUNT_KEY)) || null; } catch {}
let savedDays = []; // the account's saved days, newest first
let syncTimer = null;
let accountReturnTo = null; // the screen to go back to from the account screen

// Nothing of the app until signed in (no flash of the planner first).
if (accountsOn && !account) document.documentElement.classList.add('gated');

function hasSeasonPass() {
  if (!accountsOn) return true;
  return !!(account?.paid_until && new Date(account.paid_until) > new Date());
}

function storeAccount() {
  try {
    if (account) localStorage.setItem(ACCOUNT_KEY, JSON.stringify(account));
    else localStorage.removeItem(ACCOUNT_KEY);
  } catch {}
}

// ── Season ───────────────────────────────────────────────────────────────────
// As supabase/functions/_shared/season.ts: from May on, the coming season.

function seasonLabel(now = new Date()) {
  const year = now.getMonth() >= 4 ? now.getFullYear() : now.getFullYear() - 1;
  return `${year}/${String((year + 1) % 100).padStart(2, '0')}`;
}

function formatDay(iso) {
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
}

// ── Start ────────────────────────────────────────────────────────────────────

async function initAccount() {
  if (!accountsOn) return;
  document.getElementById('account-btn').style.display = 'inline-flex';
  document.getElementById('prefs-intro').textContent = 'Personal, kept with your account on every phone. The quick route and the day plan both use them.';
  fillCountries();
  renderGate('signin');
  renderAccountAccess();

  sb.auth.onAuthStateChange((event, session) => {
    if (event === 'PASSWORD_RECOVERY') { renderGate('newpassword'); gate(); }
    if (event === 'SIGNED_OUT' && account) signedOut();
    // Signed in by a link from an email (address confirmed) rather than the form.
    if (event === 'SIGNED_IN' && session) setTimeout(() => { if (!account) signedIn(session.user); }, 0);
  });

  // Back from Mollie: the pass arrives once the webhook has run.
  const params = new URLSearchParams(location.search);
  if (params.has('paid')) {
    history.replaceState(null, '', location.pathname + location.hash);
    if (account) waitForPass();
  }

  if (!account) return;
  const { data, error } = await sb.auth.getSession();
  if (!data?.session) {
    // Offline (or the server not reachable): carry on with the account on the phone.
    if (error || !navigator.onLine) return;
    signedOut();
    return;
  }
  await refreshProfile();
  if (localStorage.getItem(ACCOUNT_SYNC_KEY)) syncPrefs();
}

window.addEventListener('online', () => { if (accountsOn && account && localStorage.getItem(ACCOUNT_SYNC_KEY)) syncPrefs(); });

// ── Sign in, sign up, reset ──────────────────────────────────────────────────

function gate() {
  document.documentElement.classList.add('gated');
  window.scrollTo({ top: 0 });
}

function ungate() {
  document.documentElement.classList.remove('gated');
}

// One form at a time: signin, signup, reset, newpassword, or a message.
function renderGate(mode, message = '') {
  const gateEl = document.getElementById('account-gate');
  gateEl.dataset.mode = mode;
  gateEl.querySelectorAll('[data-for]').forEach(el => {
    el.style.display = el.dataset.for.split(' ').includes(mode) ? '' : 'none';
    el.querySelectorAll('input, select').forEach(input => { input.disabled = el.style.display === 'none'; });
  });
  const titles = { signin: 'Sign in', signup: 'Create your account', reset: 'Forgot your password', newpassword: 'Choose a new password', sent: 'Check your email' };
  document.getElementById('gate-title').textContent = titles[mode] || 'Sign in';
  const submit = document.getElementById('gate-submit');
  submit.textContent = { signin: 'SIGN IN', signup: 'CREATE ACCOUNT', reset: 'SEND RESET LINK', newpassword: 'SAVE PASSWORD' }[mode] || 'OK';
  submit.style.display = mode === 'sent' ? 'none' : '';
  document.getElementById('gate-password').autocomplete = mode === 'signin' ? 'current-password' : 'new-password';
  showGateMessage(message, mode === 'sent' ? 'ok' : '');
}

function showGateMessage(text, kind = 'error') {
  const el = document.getElementById('gate-msg');
  el.textContent = text;
  el.className = `gate-msg${text ? ' visible' : ''}${kind === 'ok' ? ' ok' : ''}`;
}

function ageOn(birthdate, today = new Date()) {
  const b = new Date(`${birthdate}T00:00:00`);
  let age = today.getFullYear() - b.getFullYear();
  if (today.getMonth() < b.getMonth() || (today.getMonth() === b.getMonth() && today.getDate() < b.getDate())) age--;
  return age;
}

async function gateSubmit(event) {
  event.preventDefault();
  const mode = document.getElementById('account-gate').dataset.mode;
  const email = document.getElementById('gate-email').value.trim();
  const password = document.getElementById('gate-password').value;
  const button = document.getElementById('gate-submit');
  const fail = text => { showGateMessage(text); button.disabled = false; };
  if (!navigator.onLine) return fail('You are offline. Signing in needs a connection, once.');
  button.disabled = true;
  showGateMessage('');
  const back = `${location.origin}${location.pathname}`;

  try {
    if (mode === 'signin') {
      const { data, error } = await sb.auth.signInWithPassword({ email, password });
      if (error) return fail(/confirm/i.test(error.message) ? 'Confirm your email address first: open the link in the email we sent you.' : 'Email address or password is not right.');
      await signedIn(data.user);
    } else if (mode === 'signup') {
      const birthdate = document.getElementById('gate-birthdate').value;
      const country = document.getElementById('gate-country').value;
      if (password.length < 8) return fail('Choose a password of at least 8 characters.');
      if (!birthdate) return fail('Enter your date of birth.');
      if (ageOn(birthdate) < MIN_AGE) return fail(`SkiRouter accounts are for ${MIN_AGE} and over.`);
      if (ageOn(birthdate) > 120) return fail('Check your date of birth.');
      if (!country) return fail('Choose your country.');
      if (!document.getElementById('gate-terms').checked) return fail('Agree to the terms and the privacy policy to create an account.');
      const { data, error } = await sb.auth.signUp({ email, password, options: { data: { birthdate, country }, emailRedirectTo: back } });
      if (error) return fail(/registered|exists/i.test(error.message) ? 'There is already an account with this email address. Sign in instead.' : `Could not create the account: ${error.message}`);
      if (data.session) await signedIn(data.user);
      else renderGate('sent', `We sent a link to ${email}. Open it to confirm your address, then sign in here.`);
    } else if (mode === 'reset') {
      const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: back });
      if (error) return fail(`Could not send the link: ${error.message}`);
      renderGate('sent', `If there is an account for ${email}, a link to choose a new password is on its way.`);
    } else if (mode === 'newpassword') {
      if (password.length < 8) return fail('Choose a password of at least 8 characters.');
      const { data, error } = await sb.auth.updateUser({ password });
      if (error) return fail(`Could not save the password: ${error.message}`);
      await signedIn(data.user);
    }
  } catch (err) {
    console.error(err);
    return fail('Something went wrong. Check your connection and try again.');
  }
  button.disabled = false;
}

async function signedIn(user) {
  account = { id: user.id, email: user.email };
  const ok = await refreshProfile({ fresh: true });
  if (!ok) {
    account = null;
    await sb.auth.signOut().catch(() => {});
    showGateMessage('Your account could not be loaded. Try again.');
    return;
  }
  document.getElementById('gate-password').value = '';
  ungate();
}

function signedOut() {
  account = null;
  savedDays = [];
  storeAccount();
  // The preferences are the account's: not for whoever signs in next on this phone.
  try {
    localStorage.removeItem(ACCOUNT_SYNC_KEY);
    Object.keys(collectPrefs()).forEach(key => localStorage.removeItem(key));
  } catch {}
  if (typeof reloadLocalPrefs === 'function') reloadLocalPrefs();
  closeAccount();
  renderGate('signin');
  gate();
}

async function signOutClicked() {
  await sb.auth.signOut().catch(() => {});
  signedOut();
}

// ── Profile and preferences ──────────────────────────────────────────────────

// The profile from the server: season pass and country, and the preferences.
// Just signed in on this phone (`fresh`): the account's preferences replace
// the phone's, or, for a new account, the phone's become the account's.
async function refreshProfile({ fresh = false } = {}) {
  const { data, error } = await sb.from('profiles').select('birthdate, country, prefs, paid_until').eq('id', account.id).single();
  if (error || !data) return false;
  Object.assign(account, { birthdate: data.birthdate, country: data.country, paid_until: data.paid_until });
  storeAccount();
  const unsynced = !!localStorage.getItem(ACCOUNT_SYNC_KEY);
  const serverPrefs = data.prefs || {};
  if (Object.keys(serverPrefs).length && !(unsynced && !fresh)) applyPrefs(serverPrefs);
  else if (!Object.keys(serverPrefs).length) syncPrefs();
  renderAccountAccess();
  return true;
}

function collectPrefs() {
  const out = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (SYNCED_KEYS.includes(key) || SYNCED_PREFIXES.some(p => key.startsWith(p))) out[key] = localStorage.getItem(key);
  }
  return out;
}

function applyPrefs(serverPrefs) {
  const local = collectPrefs();
  if (JSON.stringify(local) === JSON.stringify(serverPrefs)) return;
  Object.keys(local).forEach(key => { if (!(key in serverPrefs)) localStorage.removeItem(key); });
  Object.entries(serverPrefs).forEach(([key, value]) => {
    if (typeof value === 'string' && (SYNCED_KEYS.includes(key) || SYNCED_PREFIXES.some(p => key.startsWith(p)))) localStorage.setItem(key, value);
  });
  if (typeof reloadLocalPrefs === 'function') reloadLocalPrefs();
}

// app.js calls this whenever a preference changes; sent a moment later, so
// a few taps in a row are one update.
function accountPrefsChanged() {
  if (!accountsOn || !account) return;
  try { localStorage.setItem(ACCOUNT_SYNC_KEY, '1'); } catch {}
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncPrefs, SYNC_DELAY_MS);
}

async function syncPrefs() {
  if (!accountsOn || !account || !navigator.onLine) return;
  const { error } = await sb.from('profiles').update({ prefs: collectPrefs() }).eq('id', account.id);
  if (!error) try { localStorage.removeItem(ACCOUNT_SYNC_KEY); } catch {}
}

async function saveCountry(country) {
  if (!country) return;
  const { error } = await sb.from('profiles').update({ country }).eq('id', account.id);
  if (!error) { account.country = country; storeAccount(); }
  renderAccount();
}

// ── Season pass ──────────────────────────────────────────────────────────────

async function buySeasonPass(button) {
  if (!accountsOn || !account) return;
  const msg = button?.parentElement.querySelector('.paywall-msg');
  const say = text => { if (msg) { msg.textContent = text; msg.style.display = text ? 'block' : 'none'; } };
  if (!navigator.onLine) return say('You are offline. Paying needs a connection.');
  if (button) button.disabled = true;
  say('');
  try {
    const { data, error } = await sb.functions.invoke('checkout', { body: {} });
    if (error) {
      let text = 'The payment could not be started. Try again in a moment.';
      try { text = (await error.context.json()).error || text; } catch {}
      return say(text);
    }
    location.href = data.checkoutUrl;
  } catch (err) {
    console.error(err);
    say('The payment could not be started. Try again in a moment.');
  } finally {
    if (button) button.disabled = false;
  }
}

// Back from Mollie: Mollie tells our server the payment is done, usually
// within seconds; ask until the pass is there (or give up and say so).
async function waitForPass() {
  showAccountNotice('⏳ Checking your payment…');
  for (let i = 0; i < PAID_POLL_TRIES; i++) {
    if (await refreshProfile() && hasSeasonPass()) {
      showAccountNotice(`✓ Season pass ${seasonLabel()} active. Enjoy your days!`, 'ok');
      return;
    }
    await new Promise(r => setTimeout(r, PAID_POLL_MS));
  }
  showAccountNotice('Your payment has not come through yet. If you paid, the season pass appears within a few minutes — open the app again then.');
}

function showAccountNotice(text, kind = '') {
  const el = document.getElementById('account-notice');
  el.textContent = text;
  el.className = `account-notice${kind ? ' ' + kind : ''}`;
  el.style.display = text ? 'block' : 'none';
  if (kind === 'ok') setTimeout(() => { el.style.display = 'none'; }, 6000);
}

// The day planner: the season pass's, or what it offers.
function renderAccountAccess() {
  const paid = hasSeasonPass();
  const wall = document.getElementById('day-paywall');
  if (wall) {
    wall.style.display = paid ? 'none' : 'block';
    document.getElementById('day-card').style.display = paid ? '' : 'none';
    document.getElementById('day-result').style.display = paid ? '' : 'none';
    document.getElementById('paywall-price').textContent = `€${accountCfg.seasonPrice || '9.99'} for the ${seasonLabel()} season`;
  }
  const save = document.getElementById('save-day');
  if (save) save.style.display = accountsOn && paid ? '' : 'none';
  if (document.getElementById('account-screen').style.display === 'block') renderAccount();
}

// ── Saved days ───────────────────────────────────────────────────────────────

function saveDayStart() {
  document.getElementById('save-day-btn').style.display = 'none';
  const form = document.getElementById('save-day-form');
  form.style.display = 'flex';
  const input = document.getElementById('save-day-name');
  const date = new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  input.value = `${dayCtx?.startName || currentArea?.name || 'My day'} · ${date}`.slice(0, 100);
  input.focus();
  input.select();
  document.getElementById('save-day-msg').textContent = '';
}

function saveDayCancel() {
  document.getElementById('save-day-form').style.display = 'none';
  document.getElementById('save-day-btn').style.display = '';
}

async function saveDaySubmit(event) {
  event.preventDefault();
  const msg = document.getElementById('save-day-msg');
  const name = document.getElementById('save-day-name').value.trim();
  if (!name) return;
  if (!navigator.onLine) { msg.textContent = 'You are offline. Saving needs a connection.'; return; }
  const walk = dayOptions[dayShown];
  if (!walk || !currentArea) return;
  const lifts = walk.steps.filter(s => s.edge && s.edge.type !== 'piste' && s.edge.type !== 'transfer' && !isConnection(s.edge)).length;
  const row = {
    area_id: currentArea.id,
    area_name: currentArea.name,
    name: name.slice(0, 100),
    inputs: loadDayInputs(),
    option: dayShown,
    summary: {
      km: Math.round(walk.km * 10) / 10, pistes: walk.usage.size, lifts,
      start: formatClock(dayCtx.t0), end: formatClock(walk.end), from: dayCtx.startName || '',
    },
  };
  const { data, error } = await sb.from('routes').insert(row).select().single();
  if (error) {
    msg.textContent = /200/.test(error.message) ? error.message : 'Could not save this day. Try again.';
    return;
  }
  savedDays.unshift(data);
  saveDayCancel();
  const btn = document.getElementById('save-day-btn');
  btn.textContent = '✓ Saved in your account';
  setTimeout(() => { btn.textContent = '☆ Save this day'; }, 3000);
}

async function loadSavedDays() {
  if (!navigator.onLine) return;
  const { data, error } = await sb.from('routes').select('*').order('created_at', { ascending: false });
  if (!error) savedDays = data || [];
}

// A saved day: its area, its settings, planned again and shown.
async function openSavedDay(id) {
  const day = savedDays.find(d => d.id === id);
  if (!day) return;
  const meta = AREAS.find(a => a.id === areaIdNow(day.area_id));
  if (!meta) { showAccountNotice(`"${day.area_name}" is not in the ski area list any more.`); return; }
  try { localStorage.setItem(DAY_KEY_PREFIX + meta.id, JSON.stringify(day.inputs)); } catch {}
  closeAccount();
  if (currentArea?.id !== meta.id) await selectArea(meta);
  else resetDayPlan();
  if (currentArea?.id !== meta.id) return;
  const inputs = day.inputs || {};
  if (inputs.end && !restorePlace('dend', inputs.endPlace)) restoreStation('dend', inputs.end);
  showTab('day');
  clearProgress('day');
  planDay({ override: inputs });
  if (day.option > 0 && day.option < dayOptions.length) renderDayOption(day.option);
}

async function deleteSavedDay(id) {
  const day = savedDays.find(d => d.id === id);
  if (!day || !confirm(`Delete "${day.name}"?`)) return;
  const { error } = await sb.from('routes').delete().eq('id', id);
  if (error) { showAccountNotice('Could not delete it. Try again.'); return; }
  savedDays = savedDays.filter(d => d.id !== id);
  renderAccount();
}

// ── Account screen ───────────────────────────────────────────────────────────

function openAccount() {
  if (!accountsOn || !account) return;
  const screens = ['area-picker', 'planner-cards', 'prefs-screen'];
  accountReturnTo = screens.filter(id => document.getElementById(id).style.display !== 'none');
  screens.forEach(id => { document.getElementById(id).style.display = 'none'; });
  document.getElementById('account-screen').style.display = 'block';
  renderAccount();
  window.scrollTo({ top: 0 });
  loadSavedDays().then(renderAccount);
  refreshProfile();
}

function toggleAccount() {
  if (document.getElementById('account-screen').style.display === 'block') closeAccount();
  else openAccount();
}

function closeAccount() {
  const screen = document.getElementById('account-screen');
  if (screen.style.display !== 'block') return;
  screen.style.display = 'none';
  (accountReturnTo || ['area-picker']).forEach(id => { document.getElementById(id).style.display = 'block'; });
  accountReturnTo = null;
  window.scrollTo({ top: 0 });
}

function renderAccount() {
  if (!account) return;
  document.getElementById('acc-email').textContent = account.email || '';
  document.getElementById('acc-birthdate').textContent = account.birthdate ? formatDay(account.birthdate) : '—';
  const country = document.getElementById('acc-country');
  if (!country.options.length) fillCountries();
  country.value = account.country || '';

  const paid = hasSeasonPass();
  document.getElementById('acc-pass').innerHTML = paid
    ? `<strong>✓ Season pass</strong><span>Day planner and saved days until ${escapeHtml(formatDay(new Date(new Date(account.paid_until) - 1)))}</span>`
    : `<strong>Free account</strong><span>Quick routes. The season pass adds the day planner and saving your days: €${escapeHtml(accountCfg.seasonPrice || '9.99')} for the ${seasonLabel()} season.</span>`;
  document.getElementById('acc-buy').style.display = paid ? 'none' : '';

  const list = document.getElementById('acc-days');
  document.getElementById('acc-days-section').style.display = paid || savedDays.length ? '' : 'none';
  list.innerHTML = savedDays.length ? '' : '<div class="acc-empty">No saved days yet. Plan a day and tap ☆ Save this day.</div>';
  savedDays.forEach(day => {
    const s = day.summary || {};
    const row = document.createElement('div');
    row.className = 'acc-day';
    row.innerHTML = `
      <button type="button" class="acc-day-open">
        <strong>${escapeHtml(day.name)}</strong>
        <span>${escapeHtml(day.area_name)}${s.km != null ? ` · ${s.km} km · ${s.pistes} pistes · ${escapeHtml(s.start || '')}–${escapeHtml(s.end || '')}` : ''}</span>
      </button>
      <button type="button" class="acc-day-del" aria-label="Delete">🗑</button>`;
    row.querySelector('.acc-day-open').addEventListener('click', () => openSavedDay(day.id));
    row.querySelector('.acc-day-del').addEventListener('click', () => deleteSavedDay(day.id));
    list.appendChild(row);
  });
}

async function deleteAccountClicked() {
  if (!confirm('Delete your account, your preferences and your saved days? This cannot be undone. A season pass you paid for is not refunded.')) return;
  if (!navigator.onLine) { showAccountNotice('You are offline. Deleting your account needs a connection.'); return; }
  const { error } = await sb.functions.invoke('delete-account', { body: {} });
  if (error) { showAccountNotice('Your account could not be deleted. Try again, or email us.'); return; }
  await sb.auth.signOut().catch(() => {});
  signedOut();
}

// ── Countries ────────────────────────────────────────────────────────────────

const ISO_COUNTRIES = ('AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ '
  + 'CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE '
  + 'GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP '
  + 'KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF '
  + 'NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN '
  + 'SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA '
  + 'ZM ZW').split(' ');

function fillCountries() {
  let names = null;
  try { names = new Intl.DisplayNames([navigator.language || 'en', 'en'], { type: 'region' }); } catch {}
  const options = ISO_COUNTRIES
    .map(code => ({ code, name: names?.of(code) || code }))
    .sort((a, b) => a.name.localeCompare(b.name));
  ['gate-country', 'acc-country'].forEach(id => {
    const select = document.getElementById(id);
    if (!select || select.options.length > 1) return;
    select.innerHTML = '<option value="">Choose your country…</option>'
      + options.map(o => `<option value="${o.code}">${o.name}</option>`).join('');
  });
}
