# SkiRouter

Route planner for ski areas: pick a lift station, pick a destination, get the lifts and pistes to take.
Works on phone, tablet and laptop, and offline on the mountain once it has been opened.

The planner is a static site: no server, no build step, no dependencies.
It fetches `data/areas.json` and plans routes entirely in the browser.

## How development works

All work happens on GitHub; nothing needs to run on a local machine.

1. Make changes in a Claude Code cloud session (claude.ai/code) on this repository,
   or edit directly on github.com.
2. Changes go on a branch and into a pull request.
3. Merging into `main` publishes the site via `.github/workflows/pages.yml`.

A push to `main` goes live immediately, so work on a branch and merge when it is ready.

## Published site (GitHub Pages)

Only the planner files go online: `index.html`, `liftmatch.js`, `dayplan.js`, `app.js`, `styles.css`, `sw.js`,
`manifest.webmanifest`, `icons/` and `data/`.

Pages must be set to **Settings → Pages → Build and deployment → Source: GitHub Actions**.
The site is at `https://<your-username>.github.io/<repository>/`.

**On your phone:** open the site, then
- iPhone (Safari): Share → **Add to Home Screen**
- Android (Chrome): menu → **Install app** / **Add to Home screen**

Open it once with a connection; after that the planner and all ski areas work without a signal.

## Adding, updating or removing a ski area

Ask Claude in a cloud session (for example "add Saalbach"). It generates the dataset
from OpenStreetMap as `data/<id>.json` and registers it in `data/areas.json`.
You can also upload a photo of the piste map: Claude converts it with the `skimap-reader`
skill, which produces the same `data/<id>.json` format. The skill is also used for
updates to a single zone.
To remove an area, delete its file and its entry in `data/areas.json`.

Each entry in `data/areas.json` points to its data file via `file`; the service worker
pre-caches every file listed there. Phones pick up new data the next time they open
the app with a connection.

If you change the list of app files the planner needs offline, bump `CACHE_VERSION` in `sw.js`.

### Building areas from OpenSkiData (format 2)

Areas are moving to a build step, so that every European ski area can be added without
hand work. `tools/build-areas.mjs` reads [OpenSkiData](https://openskidata.org) (OpenStreetMap ski data with
elevation, lifts and runs already grouped per ski area) and compiles each area into
**format 2**:

- `liften`: as before (number, name, type, ride time, stations and their positions).
- `pistes`: every run's number, name, colour and length.
- `afdalingen`: every way down from the top of one lift to the bottom of another, as the
  runs on the way with their metres (`{ "van": "A1", "naar": "B2", "delen": [["21", 800], ["21a", 300]] }`).
  These are worked out from the run network itself — runs oriented downhill by elevation
  and joined where they meet — once per difficulty ceiling and once per run leaving the top.
- `overstappen`: stations next to each other (within 150 m, about level) — a short walk.
- `pisteLijnen`, `verbindingen`, `restaurants`: as before.

The app plans directly on these descents; it no longer needs the hand-made "which lifts
does this run reach" lists of format 1, which it still reads for areas not yet moved.
Lifts that link two summits (long, under 150 m of climb, like the 3S Bahn) get a return
lift of their own (`D9r`).

Which areas are built: `tools/build-areas.config.json`. Hand-made additions per area —
bus links, display names, lift number fixes, dropping a bad descent — go in
`overrides/<id>.json` and are applied on every build. The build also writes
`report.json`: per area the share of lift stations that can all reach each other, lifts
without a way down, and lifts you cannot ski to, from which an area gets the label
`automatisch` (complete network) or `onvolledig` (gaps).

The build runs in GitHub Actions (`.github/workflows/build-areas.yml`, by hand or on a
push to a branch that changes the build) and commits the result to `data/build/` on that
branch for review. With scope `europe` it builds every European ski area and commits only
the index and the report.

### Every European ski area in the app

Each deploy (`.github/workflows/pages.yml`) builds every European ski area into
`data/europe/` on the site: `index.json` for the area picker and one file per area under
`areas/`. These files are not in the repository. The OpenSkiData download is cached for a
day; if the Europe build fails, the site still goes out with the curated areas only.

Which areas are listed: at least 5 lifts and 10 km of pistes, and at least half of the
lifts in one connected network. Areas with 50–75 % connected are shown with "Not all lifts
are connected". Ski passes made of several separate domains (Dolomiti Superski, Ski
amadé, …) are left out; their parts (Alta Badia, Kronplatz, …) are listed on their own.
Areas in `data/areas.json` (KitzSki, with lift status and restaurants) are not listed twice.

Some valleys have no ski area of their own in OpenSkiData, only the pass they are part of. Val
Gardena, for example, is only in "Dolomiti Superski", which is hidden as a pass of separate
domains. So every part of such a hidden pass with at least 10 lifts is built as an area of its
own, with the runs in and around it. A part is skipped when 80 % of its lifts are in one area
that is listed already (Kronplatz, Megève, …). Its name and search words come from the listed
areas it overlaps. For a few parts they are set under `splits` in
`tools/build-areas.config.json`, such as "Sella Ronda – Val Gardena, Alta Badia, Arabba, Val
di Fassa", which can be found by searching Val Gardena, Gröden, Selva, Ortisei and so on. The build
report lists every part and what became of it.

The area picker searches names, villages, regions and countries (with a few local names:
Tirol, Wallis, Südtirol, …), finds ski areas near you, keeps your favourites (tap ☆) on top
and lists every area per country (KitzSki under Austria). An area is downloaded when you open it and then stays
available offline. Areas without known mountain restaurants plan a day without the lunch
box. Lifts without a number in the map data show their name only.

### Mountain restaurants for every area

`tools/fetch-pois.mjs` asks OpenStreetMap (Overpass API) for restaurants, cafés, bars and
huts around every built area and keeps the ones within 100 m of a run or 130 m of a top
station in `data/pois/europe.json`. The build links them to the area with the same rules
as the KitzSki enrichment below (80 m of a piste, huts 100 m, 130 m of a top station;
within 130 m of a station it is linked to that station, else to its run).

The public Overpass servers are often busy, so `.github/workflows/pois.yml` runs daily:
each run spends at most about 80 minutes, starts with the areas never fetched (or fetched
longest ago), skips areas fetched in the last 6 days, and commits the file when it changed,
after which it redeploys the site. An area whose query keeps failing keeps the places it
had. Start it by hand from **Actions → Fetch mountain restaurants → Run workflow**.

In big areas the day planner tries at most 16 lunch stops when no restaurant is chosen:
ones you can reach by lunchtime and get back from, the same sample for the same inputs.

Map data © OpenStreetMap contributors (ODbL), via OpenSkiMap / OpenSkiData; the picker
says so.

## Picking a lift station

The station picker lists each lift once, with its status. Picking a lift chooses its bottom
station. The chosen field then has a **⬇ Bottom / ⬆ Top** switch; tap **Top** to start or end at
the top station instead.

## Which way off the lift

On the lift step you are at (the first one not ticked yet), the planners say which way to go when you get off: "↱ Off the lift,
turn right to piste 21", left, straight on or turn around. The direction you ride is the
line from the station you board to the one you leave. The next piste is followed for about
80 m down from where it is closest to the exit station. When it only starts further away
(up to 500 m, at the end of a connecting path), its nearest point is used instead. When the
route goes on with another lift, the hint points to that lift's bottom station. Both
directions come from the map data (`coordOnder`/`coordBoven`, `pisteLijnen`). There is no
hint when the piste is further away, or when the data has no course for it: about 6 in 10
lift–piste pairs in KitzSki and nearly all in the areas built from OpenSkiData get one.

## Riding a lift down

Some valley stations have no piste down to them, such as G8 Panoramabahn in Hollersbach. Both
planners then route you down by lift ("ride down ↓"). That only happens with gondolas, cable cars
and funiculars, never with chairlifts, drag lifts or carpets, and only when no piste gets you
there: the planners count riding down as an extra hour of cost, while showing the real ride time.

## Bus and walking connections

Some lift stations are only linked through the valley, such as Hahnenkammbahn (A1) and Hornbahn
(H1) in Kitzbühel. These links go in the area file as `verbindingen`, curated by hand:

```json
"verbindingen": [
  { "van": "A1-onder", "naar": "H1-onder", "soort": "bus", "tijd": 15,
    "naam": "Ski bus Kitzbühel", "info": "Ski bus through town, or about 15 min on foot." }
]
```

- `van` / `naar`: station ids (`<liftNr>-onder` for a bottom station, `-boven` for a top station).
- `soort`: `bus` or `lopen` (walk). `tijd`: minutes door to door. Both directions unless
  `"beideRichtingen": false`.
- Both planners use them, with a 🚌 / 🚶 step; skiing wins when it is about as quick.
- When an area has a ski bus link, both planners show a **🚌 Ski bus** switch; switched off,
  routes and day plans use lifts and pistes only.

The OSM enrichment stores every station's coordinates (`coordOnder` / `coordBoven`) and the
nearest named bus stop (`bushalte`), which help to work out a sensible `tijd`.

## Lift status and opening hours

Every 30 minutes, `.github/workflows/lift-status.yml` runs `tools/lift-status.mjs`, which reads
each area's own lift list and writes `data/<area>-liftstatus.json`: per lift whether it is open,
today's operating hours, the operating period and weekdays. The file is only committed when
something changed; the workflow then redeploys the site. For KitzSki the source is the API behind
kitzski.at's lift status page (Micado SkigebieteManager). An area opts in with a `liftstatus`
entry in `data/areas.json`.

The app shows "open 08:30–17:00" or "closed" in the station picker and at every lift step, warns
about closed lifts on a route or day plan, and the day planner uses today's hours as lift windows.
GitHub runs scheduled workflows on a best-effort basis, so an update can now and then be a little
later than 30 minutes. That is why the app also fetches the status live, straight from kitzski.at
(its API allows requests from other sites), when an area opens and every 5 minutes while the app is
on screen. The latest live result is kept on the phone. Without a connection the app uses whichever
is newer, that stored result or the file from GitHub Actions. The tip then says "live" or not.

### Live lift status for European ski areas

Many European areas publish their lift status through a few providers. The planner reads
four of them:
- **Intermaps:** the interactive piste maps of many Austrian, German, Swiss and Italian areas.
  Every map has a JSON feed at `<map>/data`.
- **Infosnow:** Switzerland.
- **Lumiplan:** French snow bulletins, with opening hours.
- **Micado:** SkiWelt.

The parsers are in `tools/lib/liftstatus-providers.mjs`.

- **Which areas** (weekly, `.github/workflows/liftstatus-sources.yml`):
  `tools/liftstatus-sources.mjs` finds candidate sources in four ways: on each area's website
  (from OpenSkiData), by guessing map and station names from area and village names, by
  trying every Infosnow page, and from the Micado sites. Each source belongs to the area
  whose lift names it matches best. An area gets live status when its sources cover at least
  75 % of its named lifts. The result goes into `data/liftstatus/sources.json` and
  `report.md`; the deploy then marks those areas in the area list.
- **The status** (every 30 minutes from 06:00 to 19:00, `.github/workflows/liftstatus-europe.yml`):
  `tools/liftstatus-europe.mjs` writes one file per area with the provider's own lift names,
  open or closed and, where known, the hours. The files are published as the single commit of
  the `liftstatus` branch, replaced on every run, so main and the site are not touched. When
  a source cannot be read, the area keeps its previous file and time.
- **In the app:** the app reads the file from `raw.githubusercontent.com` (the repository is
  public). It matches the names to the area's lifts with `liftmatch.js`, refreshes every 5
  minutes, and keeps the last status on the phone for offline use. Names are compared without
  accents, type words ("TSD", "8EUB", "Sesselbahn") or map codes ("A", "C3"), with Roman
  numerals as digits; two lifts whose numbers differ are never matched. In the area picker
  every area says "● Live lift status" or "○ No live lift status". Once an area is open, the
  same line sits under its facts at the top, with the time of the last update. From there,
  everything works as for KitzSki: status in the station picker, warnings, avoiding and the day planner's lift
  hours.

## Avoiding lifts

Any lift can be skipped by hand, open or closed: **⊘ Avoid** on a lift step adds it to a list
(per ski area, kept on the phone) and plans the route again without it; a day being followed is
replanned from the next step. The closed-lifts warning has **Avoid these** for all closed lifts on
the route at once. Avoided lifts show as chips in both planners; ✕ takes one off the list. If no
route is left, the message names the avoided lifts.

## Where am I (GPS)

In the station picker for a starting point, **Use my location** starts the route where you are:
a short walk to any lift station within 300 m, or — when you are within 80 m of a piste — the rest
of that run to wherever it ends (counted as half the run). Further away, the route starts at the
nearest lift station and says how far it is; more than 5 km away, the app says you are not in the
ski area. Station positions and piste courses come from the OSM enrichment (`coordOnder`,
`coordBoven`, `pisteLijnen`). The browser asks for permission the first time.

## Day planner

The **Day plan** tab plans a whole day: a start station and time, roughly how many
kilometres, and when (and where) to be back. It tries many routes through the lift and
piste network, prefers pistes not skied yet that day, and offers up to three options
with a time for every step. Times are a guideline: lift ride plus a queue that depends on the chosen pace,
and piste times stretched for short stops. The code is in `dayplan.js`.

With **Lunch** switched on, the day becomes start → restaurant (around the chosen time) →
end. The planner tries every restaurant on the mountain that fits, or only the one picked
under *Where*, and says which one lies right on the route. It also lists other huts you pass
around lunchtime. Restaurants come from the OpenStreetMap enrichment below; places in the
villages are left out, as are places whose mapped opening hours do not cover your arrival.

### Following a route

In both planners you tap a step once you have done it. A tap also ticks every step before
it, so you can catch up after forgetting. Tap a ticked step to untick it and everything after
it. The quick route shows how many minutes are left. The day plan compares the clock with the
plan, shows whether you are on schedule, ahead or behind, and offers **Replan from here**:
the rest of the day is planned again from the next step, from now, with the km still to go.
Progress is stored on the phone, so a route being followed comes back when the app is
reopened. **Calculate route** and **Plan my day** start afresh with nothing ticked, also when
it is the same route as before.

When the delay carried through to the end of the day means getting back more than 10 minutes
after **Back by**, the day plan warns automatically (checked against the clock every minute, also
without tapping): a red bar in the sticky header and a warning above the steps, both with
**Replan from here**. The phone vibrates once when the warning first appears.

## OpenStreetMap enrichment

`tools/osm-enrich.mjs` adds restaurants and huts and lift opening hours, where mapped, to every
dataset in `data/areas.json`. Only places on the piste are kept: within 80 m of a piste's course
(huts 100 m) or 130 m of a top station. A place within 130 m of a lift station is linked to that
station, otherwise to its piste. Piste ways more than 1.5 km from every lift belong to a
neighbouring area and are ignored.
It runs in GitHub Actions (`.github/workflows/osm-enrich.yml`) because cloud sessions
cannot reach OpenStreetMap: start it from **Actions → Enrich ski areas from OSM → Run
workflow**, or push a change to the script on a branch. The workflow commits the
updated data back to that branch.

## Previewing a change

Any static file server works, for example `npx serve .` or `python -m http.server`
inside a cloud session. Service workers need `http://localhost` or HTTPS.
