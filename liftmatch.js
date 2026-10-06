// Matches the lift names of a lift status source (Intermaps, Infosnow,
// Lumiplan, …) to the lifts of an area built from OpenStreetMap. Used by the
// app, to show a Europe area's live status on our lifts, and by
// tools/liftstatus-sources.mjs, to decide which areas match well enough.
//
// Names are compared without accents, punctuation, type words ("TSD",
// "Sesselbahn", "8EUB", "4-seater"), leading map codes ("A", "C3", "12") and
// with Roman numerals as digits, so "C 6er Sesselbahn Golmerbahn II" and
// "Golmerbahn 2" are the same lift. Lift numbers must agree when both names
// have one. Our lifts without a real name (L5, OEF-3) are never matched.
//
// A plain script (no modules), so the app can load it as is; Node loads it
// with vm.runInThisContext.

(function (root) {
  const TYPE_WORD = new RegExp('^(' + [
    'telesiege', 'teleski', 'telecabine', 'telepherique', 'telemix', 'funiculaire', 'tapis', 'telebaby',
    'tsd\\d*', 'tsf\\d*', 'ts', 'tk', 'tc', 'tph', 'tps', 'tp', 'tlc', 'tm', 'tb', 'tr',
    'ski', 'skilift', 'lift', 'lifte', 'lifts', 'chair', 'chairlift', 'drag', 'draglift', 'gondola', 'cable', 'car', 'cableway',
    'gondel', 'gondelbahn', 'kabinenbahn', 'kabinen', 'seilbahn', 'pendelbahn', 'standseilbahn', 'zahnradbahn',
    'sesselbahn', 'sessellift', 'sesselift', 'schlepplift', 'tellerlift', 'bahn', 'express', 'kombibahn', 'kombilift',
    'seggiovia', 'sciovia', 'cabinovia', 'funivia', 'tappeto', 'sl', 'sb', 'eub', 'kb', 'ksb', 'gub', 'pb', 'dsb', 'ssb',
    'seater', 'sixpack', 'sektion', 'section', 'der', 'de', 'la', 'le', 'les', 'du', 'des', 'di', 'del', 'am', 'im',
    '\\d+(er|sb|eub|ksb|kb|sk|sl|seater|ers|gub|dsb)',
  ].join('|') + ')$');
  const ROMAN = { i: '1', ii: '2', iii: '3', iv: '4', v: '5', vi: '6' };
  const SIDE = /^(rechts|links|left|right|gauche|droite|destra|sinistra)$/;
  const SUFFIX = /(sesselbahn|sessellift|gondelbahn|seilbahn|schlepplift|tellerlift|bahn|lifte|lift)$/;

  // "C 6er Sesselbahn Golmerbahn II" -> { words: ['golmer'], numbers: ['2'] }
  function liftNameKey(name) {
    let tokens = String(name || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss')
      .replace(/(\d+)\.(?!\d)/g, '$1').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
    // A map code in front: "A", "C3", "12", "L8".
    if (tokens.length > 1 && /^([a-z]\d{0,2}|\d{1,3}[a-z]?)$/.test(tokens[0])) tokens = tokens.slice(1);
    tokens = tokens.map(t => ROMAN[t] || t).filter(t => !TYPE_WORD.test(t))
      .map(t => (/\d/.test(t) ? t : (t.replace(SUFFIX, '').length >= 4 ? t.replace(SUFFIX, '') : t)));
    return {
      words: tokens.filter(t => !/^\d+[a-z]?$/.test(t)),
      numbers: tokens.filter(t => /^\d+[a-z]?$/.test(t)),
    };
  }

  function similar(a, b) {
    if (a === b) return true;
    if (Math.min(a.length, b.length) < 5) return false;
    // Levenshtein, for spellings like Zeinis/Zenis or Dreiwiesn/Dreiwiesen.
    const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      let diag = prev[0];
      prev[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const tmp = prev[j];
        prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
        diag = tmp;
      }
    }
    return prev[b.length] <= Math.max(1, Math.floor(Math.max(a.length, b.length) / 6));
  }

  // 0 (different) … 1 (same name).
  function nameScore(a, b) {
    if (!a.words.length || !b.words.length) return 0;
    if (a.numbers.length && b.numbers.length && a.numbers.join() !== b.numbers.join()) return 0;
    // "Jackalmlift rechts" is one of two parallel lifts; "Jackalmlift I" may be the other.
    const side = k => k.words.some(w => SIDE.test(w));
    if ((side(a) && b.numbers.length && !a.numbers.length) || (side(b) && a.numbers.length && !b.numbers.length)) return 0;
    const numberPenalty = (a.numbers.length > 0) !== (b.numbers.length > 0) ? 0.15 : 0;
    const ja = a.words.join(''), jb = b.words.join('');
    if (ja === jb) return 1 - numberPenalty;
    if (Math.min(ja.length, jb.length) >= 4 && (ja.includes(jb) || jb.includes(ja))) return 0.85 - numberPenalty;
    const shared = a.words.filter(w => b.words.some(v => similar(w, v))).length;
    const share = shared / Math.max(a.words.length, b.words.length);
    if (shared && share >= 0.5) return 0.6 + 0.25 * share - numberPenalty;
    if (similar(ja, jb)) return 0.8 - numberPenalty;
    return 0;
  }

  const GENERIC = /^(L\d+|OEF-\d+)([a-z]|-\d+)?$/;

  // ours: [{ liftNr, naam }], theirs: [{ n }] -> { liftNr: index in theirs }.
  // Best pairs first, each source lift used once, except for our lifts that
  // carry the same name (sections or a return lift of one installation).
  function matchLifts(ours, theirs) {
    const ourKeys = ours.map(l => (l.naam && !GENERIC.test(l.naam) ? liftNameKey(l.naam) : null));
    const theirKeys = theirs.map(t => liftNameKey(t.n));
    const pairs = [];
    ourKeys.forEach((ok, i) => {
      if (!ok) return;
      theirKeys.forEach((tk, j) => {
        const s = nameScore(ok, tk);
        if (s >= 0.6) pairs.push([s, i, j]);
      });
    });
    pairs.sort((x, y) => y[0] - x[0]);
    const result = {};
    const usedBy = new Map(); // their index -> our name key
    for (const [, i, j] of pairs) {
      const nr = ours[i].liftNr;
      if (nr in result) continue;
      const key = ourKeys[i].words.join(' ') + '|' + ourKeys[i].numbers.join(' ');
      if (usedBy.has(j) && usedBy.get(j) !== key) continue;
      usedBy.set(j, key);
      result[nr] = j;
    }
    return result;
  }

  // How many of our named lifts a source covers (0–100).
  function matchShare(ours, theirs) {
    const named = ours.filter(l => l.naam && !GENERIC.test(l.naam) && l.type !== 'magic_carpet');
    if (!named.length) return 0;
    const matched = matchLifts(named, theirs);
    return Math.round(100 * Object.keys(matched).length / named.length);
  }

  root.liftNameKey = liftNameKey;
  root.matchLifts = matchLifts;
  root.matchShare = matchShare;
})(typeof globalThis !== 'undefined' ? globalThis : this);
