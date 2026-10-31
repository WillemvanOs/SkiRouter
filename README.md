# SkiRouter

Route planner for ski areas: pick a lift station, pick a destination, get the lifts and pistes to take.
Works on phone, tablet and laptop, and offline on the mountain once it has been opened.

The planner is a static site: no server, no build step, no dependencies.
It fetches the list of ski areas and plans routes entirely in the browser.

## How development works

All work happens on GitHub; nothing needs to run on a local machine.

1. Make changes in a Claude Code cloud session (claude.ai/code) on this repository,
   or edit directly on github.com.
2. Changes go on a branch and into a pull request.
3. Merging into `main` publishes the site via `.github/workflows/pages.yml`.

A push to `main` goes live immediately, so work on a branch and merge when it is ready.

## Published site (GitHub Pages)

Only the planner files go online: `index.html`, `config.js`, `account.js`, `icons.js`, `liftmatch.js`, `map.js`, `dayplan.js`,
`app.js`, `styles.css`, `sw.js`, `manifest.webmanifest`, `privacy.html`, `terms.html`, `legal.css`, `icons/`, `vendor/` and `data/`.

The typefaces (Bebas Neue and DM Sans, SIL Open Font License, `vendor/fonts/OFL.txt`) are
served from the site itself (`vendor/fonts/`, from Fontsource), not from Google Fonts, so
opening the app sends nobody's IP address to Google; the service worker keeps them offline.

Pages must be set to **Settings → Pages → Build and deployment → Source: GitHub Actions**.
The site is at `https://<your-username>.github.io/<repository>/`.

**On your phone:** open the site, then
- iPhone (Safari): Share → **Add to Home Screen**
- Android (Chrome): menu → **Install app** / **Add to Home screen**

Open it once with a connection; after that the planner and all ski areas work without a signal.

## Adding, updating or removing a ski area

Every European ski area in OpenSkiData is built automatically on each deploy (see below), KitzSki
included; fixes for one area (a bus link, a name) go in `overrides/<id>.json`.
Only for an area that is not in the map data: upload a photo of the piste map and Claude converts it
with the `skimap-reader` skill into `data/<id>.json`, registered in `data/areas.json`.
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
  Small pieces fold into the piste around them, so a step is a piste you would name: pieces
  under 60 m, unnamed connectors and unnumbered stretches (mapped under a lift's name) under
  300 m next to a numbered piste, and a stretch under 200 m between two parts of one piste
  where it crosses another (A1 → C1 is one step "37", not 37 – Kapellenabfahrt – 19 – 37).
  A folded piece that is harder keeps its colour for the difficulty filter.
  A way shared by several pistes (mapped with all their numbers, "16a;28a;38") belongs to each
  of them: on a route it is the piste you are on already, or the one that goes on furthest, so
  C1 → D5 is 28a then 28, not "Streiteck" twice first.
- `overstappen`: stations next to each other (within 150 m, about level) — a short walk.
- `pisteLijnen`, `verbindingen`, `restaurants`: as before.

The app plans directly on these descents; it no longer needs the hand-made "which lifts
does this run reach" lists of format 1, which it still reads for areas not yet moved.
Lifts that link two summits (long, under 150 m of climb, like the 3S Bahn) get a return
lift of their own (`D9r`).

Every area is built the same way, KitzSki included: the config only gives it the id `kitzski`
and its name, and `overrides/kitzski.json` adds the ski bus through Kitzbühel. (Until October 2026
KitzSki was a hand-made format-1 file whose "lifts a piste reaches" lists, with one length for all,
made a route over several pistes look like one short piste, and had some lifts in the wrong place.)

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
day; if the Europe build fails, the site still goes out with the hand-made areas only.

Which areas are listed: at least 5 lifts and 10 km of pistes, and at least half of the
lifts in one connected network. Areas with 50–75 % connected are shown with "Not all lifts
are connected". Ski passes made of several separate domains (Dolomiti Superski, Ski
amadé, …) are left out; their parts (Alta Badia, Kronplatz, …) are listed on their own.
Hand-made areas in `data/areas.json` (from a piste map photo) are not listed twice.

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

`tools/fetch-pois.mjs` takes the restaurants, cafés, bars and huts around every built area
from our own OpenStreetMap extract (see *Our own OpenStreetMap extract* below) and keeps the ones within 100 m of a run or 130 m of a top
station in `data/pois/europe.json`. The build links them to the area with the same rules
as the OSM enrichment below (80 m of a piste, huts 100 m, 130 m of a top station;
within 130 m of a station it is linked to that station, else to its run).

`.github/workflows/pois.yml` runs daily and does every area each time (the extract is on
disk, so that takes seconds); it commits the file when it changed, after which it redeploys
the site. Start it by hand from **Actions → Fetch mountain restaurants → Run workflow**.

### Our own OpenStreetMap extract

The public Overpass API asks commercial users to run their own server, so SkiRouter does not
use it. `tools/osm-extract.sh` makes an extract instead:
- `tools/osm-regions.mjs` picks, from Geofabrik's region list, the smallest regions that hold
  the ski areas (Tirol rather than Austria), so as little as possible is downloaded;
- each region is downloaded from Geofabrik, cut down with `osmium tags-filter` to what the
  app uses (places to eat, huts, peaks, villages, viewpoints, snow parks, lifts, pistes and
  bus stops) and exported as GeoJSON, one feature per line, one region on disk at a time;
- `tools/lib/osm-local.mjs` reads that back as Overpass-style elements for
  `tools/fetch-pois.mjs` and `tools/osm-enrich.mjs` (`--osm <file>`).

`pois.yml` makes the extract once a week and keeps it in the Actions cache in between, so
Geofabrik is asked once a week. Locally: `tools/osm-extract.sh build/osm.geojsonseq` (needs
`osmium-tool`).

In big areas the day planner tries at most 16 lunch stops when no restaurant is chosen:
ones you can reach by lunchtime and get back from, the same sample for the same inputs.

Map data © OpenStreetMap contributors (ODbL), via OpenSkiMap / OpenSkiData; the picker
says so.

## Icons

All pictograms come from one set in `icons.js`: lifts (gondola, cable car, funicular, chairlift,
drag lift, practice lift), connections (transfer, ski bus, walk), places (restaurant, viewpoint,
snow park, village, hamlet, peak) and the route's start pin and finish flag. They are drawn alike
(24 × 24, round strokes, `currentColor`), so the steps, the lists and the map look the same on every
phone instead of mixing the phone's emoji with drawings of our own. The tile or class around an
icon sets its colour (`styles.css`, `.ico-<kind>` and `.icon-<name>`).

## Picking a lift station

The station picker lists each lift once with its status: by lift number where the area has them (A1, A2, A10,
B1, …), then the lifts without one A to Z by name. The keyboard opens
with it for searching; the first swipe on the list (or Go) puts it away. The sheet keeps one
size whether the keyboard is open or not (the keyboard just covers its bottom), because an
iPhone stutters when a list resizes under the finger. Picking a lift chooses its bottom
station. The chosen field then has a **⬇ Bottom / ⬆ Top** switch; tap **Top** to start or end at
the top station instead.

### Places: points of interest, villages and peaks

At the top of the picker, **Lifts | POI | Villages & peaks** chooses what it lists; it opens on
Lifts every time. POI are the mountain restaurants and huts, viewpoints and snow parks;
Villages & peaks are the area's `plaatsen`. A place is not on the lift network itself: it goes
by the nearest lift station of the area's main network (a village by the nearest bottom
station; a practice lift on its own in a village does not count), and the route says how far
that is ("350 m from bottom of E2 Schatzerlift"). Places further than 1.5 km from any lift are
left out. Viewpoints and snow parks (`plekken`) come with the landmarks fetch
(`tools/lib/landmarks.mjs`: within 300 m of a lift or a run, named ones first).

### Picking on the map

**🗺 Map** at the top of the picker shows the area instead of the list (**☰ List** goes back;
the picker remembers which one you used last until the app is closed). Every lift is a line
with its code. A tap never picks straight away: it first shows what was tapped (for a lift its
type, ride time and opening hours; for a place what it is, its height and the lift it goes by)
with one button to confirm (**Start here**, **Go here**, **Add as stop**). A lift is always
picked by its bottom station; the **⬇ Bottom / ⬆ Top** switch on the chosen field changes that
afterwards. With POI or Villages & peaks chosen, those places are on the map too as bigger
icons (the lifts lighter and not tappable); a tap close to an icon counts as well. The map
keeps its zoom and spot when you switch between Lifts, POI and Villages & peaks, and shows the
same orientation in all three: the pistes, every lift with its code, and the names of villages and
peaks (under their icon while those are what you pick). A chosen place
shows its name with where it is underneath. Same plain
map as the route map, north up unless the compass on a route map turned it. Search works in the list only: typing goes back to it.

### Stops and lunch in the day plan

Under **📍 Stops & lunch** (folded by default, with a summary such as "1 stop · lunch 13:00") the day plan takes places to pass: a lift to ride (its top
station), or any place from the picker. **Lunch** is one of the stops, the only one with a time
(and its length, and where: best fit or one restaurant); it is there by default in areas with
mountain restaurants, and **+ Add lunch** brings it back. ✕ removes a stop. The order they were
added in does not matter: the plan passes them in the order that is quickest to get past them
all (every order is tried for up to seven stops; with more, the nearest next and then pairs
swapped while it helps). The day is planned in legs, start → stop → … → end: each leg gets the
quickest time between its ends plus a share of the time left (longer legs a bigger share), and
the same share of the distance. Lunch goes in the leg that is under way around its time, where
the stops before and after it fit; the time before it is shared out over the stops before it,
the time after over the rest. Its leg is planned like a lunch day of its own. Legs are
planned one after another, each knowing what was skied already, and the three options avoid
each other leg by leg. A stop shows as a waypoint between the steps (not one to tick) and on
the map; **Replan from here** keeps only the stops still ahead.

## Route map

A quick route and a day plan can each be shown as a list or as a map (**☰ List | 🗺 Map**). The
map is drawn the way a paper piste map is, but flat and plain: no map tiles, just the area's own
data on a light background, so it works offline and is easy to read.
- **Valley down, mountain up.** The map is turned so the lifts, on average, go up the screen,
  as on a piste map seen from the valley. Where lifts go every which way (around a valley), it
  stays north up. Every map opens north up; tap the compass to turn it like a piste map (until
  the app is closed), and again for north up.
- **The route on top of a faint area.** Pistes are thick lines in their colour, lifts thin dark
  lines with a dot at each station, and arrows show which way you go. The lifts and pistes of the
  route carry their number, as on a piste map: a lift's code in a dark box, a piste's number in a
  circle of its colour (runs without a number go by their name). A piste mapped in OpenStreetMap
  as several ways (a fork, a later stretch, ways that stop a few metres apart) is followed over
  all of them, so it is drawn the whole way down to the lift (`pisteSegment` in `map.js`). Where
  the next mapped course still starts away from where the last one ended (the data has no piste
  there), a dotted line keeps the route in one piece.
- **It follows you.** The map opens on the step you are at (its label yellow) and the next three,
  in full colour; the rest of the route is lighter and the steps done are grey. Tick a step and
  the map moves on. **⤢ Whole route** shows all of it, **◎ My step** goes back.
- **Places to find your way.** Towns, villages, hamlets at a lift and named peaks (with their
  height) come from OpenStreetMap (`plaatsen`, see below). Start and finish are named. In a day
  plan, lunch is a 🍽 at the restaurant and counts as a step.
- Labels that would overlap are hidden, the least important first (the step you are at, lunch,
  the next steps, start and finish, towns, the rest of the route, villages, peaks, steps done,
  hamlets); zooming in brings them back.
- ⛶ shows the map full screen (also on iPhone), 📍 shows and follows your position, and a tap on a
  line or label gives its name.

The map uses Leaflet (`vendor/leaflet`, BSD-2-Clause), loaded the first time the map is opened
and kept offline by the service worker. The code is in `map.js`.

**Landmarks.** `node tools/fetch-pois.mjs --kind landmarks` asks OpenStreetMap for named peaks,
towns, villages and hamlets in and around every area (about 1.5 km) into
`data/pois/landmarks.json`; it runs daily with the restaurants (`.github/workflows/pois.yml`,
each area every 30 days, with the time the restaurants leave). The area build gives each area its own (`plaatsen`: up to 25 peaks, those at a lift or a run first, then the highest around; up to 20 towns and villages,
and hamlets only near a lift; `tools/lib/landmarks.mjs`).
The hand-curated areas in `data/areas.json` are not built, so the fetch writes theirs into
their file.

## Which way off the lift

On the lift step you are at (the first one not ticked yet), the planners say which way to go when you get off: "↱ Off the lift,
turn right to piste 21", left, straight on or turn around. The direction you ride is the
line from the station you board to the one you leave. The next piste is followed for about
80 m down from where it is closest to the exit station. When it only starts further away
(up to 500 m, at the end of a connecting path), its nearest point is used instead. When the
route goes on with another lift, the hint points to that lift's bottom station. Both
directions come from the map data (`coordOnder`/`coordBoven`, `pisteLijnen`). There is no
hint when the piste is further away, or when the data has no course for it: nearly all
lift–piste pairs in the areas built from OpenSkiData get one.

## Riding a lift down

Some valley stations have no piste down to them, such as G8 Panoramabahn in Hollersbach. Both
planners then route you down by lift ("ride down ↓"). That only happens with gondolas, cable cars
and funiculars, never with chairlifts, drag lifts or carpets, and only when no piste gets you
there: the planners count riding down as an extra hour of cost, while showing the real ride time.

## Bus and walking connections

Some lift stations are only linked through the valley, such as Hahnenkammbahn (A1) and Hornbahn
(H1) in Kitzbühel. These links go in `overrides/<id>.json` (the build adds them to the area) as `verbindingen`, by hand:

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

Areas built from OpenSkiData get walks generated between stations up to 500 m apart on the same
level, but only where skiing does not already get you there: between two bottom stations (valley
stations in one village), and from a top station to the bottom of a lift that no run from that
top reaches (one way). Never to a top station: its lift, or a run past it, gets you there. The
app applies the same rule when it loads an area, also to data built before it. The day planner
treats a walk as a last resort: it hardly ever picks one while lifts and runs are on offer, and
never two in a row (on the way back to the end station a walk is still taken when it is the
quickest).

The OSM enrichment stores every station's coordinates (`coordOnder` / `coordBoven`) and the
nearest named bus stop (`bushalte`), which help to work out a sensible `tijd`.

## Lift status and opening hours

Per lift whether it is open and, where the source says, today's operating hours: from the area's
lift status provider, every 30 minutes (below). The app shows "open 08:30–17:00" or "closed" in
the station picker and at every lift step, warns about closed lifts on a route or day plan, and the
day planner uses today's hours as lift windows. The app fetches the status again every 5 minutes
while it is on screen and keeps the latest on the phone, so it is there offline too.

### Live lift status for European ski areas

Many European areas publish their lift status through a few providers. The planner reads
four of them:
- **Intermaps:** the interactive piste maps of many Austrian, German, Swiss and Italian areas.
  Every map has a JSON feed at `<map>/data`.
- **Infosnow:** Switzerland.
- **Lumiplan:** French snow bulletins, with opening hours.
- **Micado:** SkiWelt and KitzSki.

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
  everything works the same in every area: status in the station picker, warnings, avoiding and the day planner's lift
  hours.

## Avoiding lifts and pistes

Any lift can be skipped by hand, open or closed: **⊘ Avoid lift** in the step menu (below)
adds it to a list (per ski area, kept on the phone) and plans the route again without it; a day being followed is
replanned from the next step. The closed-lifts warning has **Avoid these** for all closed lifts on
the route at once. Avoided lifts and pistes show as chips in both planners; ✕ takes one off the
list. If no route is left, the message says so.

**Swipe a step left, or hold it** (the phone gives a short tick when the hold opens the menu;
on an iPhone that needs iOS 18, as Safari has no vibration API), for a short menu: **↻ Replan from here** (day plan: the
steps before it count as done and the rest of the day is planned again from there),
**⊘ Avoid lift** on a lift step and **⊘ Avoid piste** on a piste step (a descent through
several pistes avoids all of them). Avoided pistes are kept per area next to the lifts
(`skiplanner:avoidpiste:<area>`). A tap still ticks a step; scrolling up and down is untouched.

## Accounts and the season pass

Everyone signs in: email address, password, date of birth (16 and over, GDPR art. 8) and
country. The preferences (`skirouter:prefs`, favourite areas, avoided lifts and pistes) go
with the account, so they follow you to another phone. A free account plans quick routes;
the **season pass** (one payment per winter, valid until 30 June; bought from May on it is
for the coming season) adds the **day planner** and **saving days** in the account. 👤 in the
header opens the account: season pass, saved days (tap one to plan it again in its area, with
the settings it was saved with), country, sign out and delete account. Without the pass the
Day plan tab shows what the pass offers and a button to buy it.

How it fits together:

- **Supabase** (auth + Postgres + Edge Functions). `supabase/migrations/` makes the tables
  `profiles`, `payments` and `routes`, with row level security: everyone reads and changes
  only their own rows; the season pass (`profiles.paid_until`) and payments are written by
  the functions alone; saving a day needs a valid pass (checked in the database, not only in
  the app). Signing up creates the profile in the same step and fails under 16.
- **Mollie** (`supabase/functions/checkout`): makes a payment for the signed-in user and sends
  them to Mollie's checkout. Mollie then calls `mollie-webhook`, which fetches the payment from
  Mollie itself (never trusting the call) and, once it is paid, sets `paid_until`. Back in the
  app (`?paid=1`) the app asks for the profile until the pass is there.
- **The app** (`account.js`, `config.js`, `vendor/supabase/` = supabase-js 2.118.0, MIT): the
  sign-in screen before anything else, the account screen, the day planner behind the pass.
  The day planner itself still runs in the browser, so the pass is checked by the app; saved
  days are checked by the database. The signed-in account is kept on the phone, so the app
  opens offline on the mountain; preference changes made offline are sent once online.
- With `config.js` left empty, accounts are off and the app works as before, all free.

**Setting it up** (once):

1. Create a project at [supabase.com](https://supabase.com), region **EU (Frankfurt)**. Sign
   the data processing agreement (Settings → Legal).
2. Install the [Supabase CLI](https://supabase.com/docs/guides/cli), then in this repository:
   `supabase login`, `supabase link --project-ref <ref>`, `supabase db push` (the tables).
3. Mollie: make an account at [mollie.com](https://www.mollie.com) and copy the API key (test
   key `test_…` first, live key `live_…` once Mollie has approved you). Then:
   `supabase secrets set MOLLIE_API_KEY=test_… APP_URL=https://<where the app is> SEASON_PRICE=9.99`
   and `supabase functions deploy checkout delete-account` plus
   `supabase functions deploy mollie-webhook --no-verify-jwt`.
4. Supabase → Authentication → URL Configuration: **Site URL** = the app's address, and add it
   under Redirect URLs (the links in the confirmation and password emails go there).
   Authentication → Emails: set up your own SMTP sender (Supabase's own is for testing only,
   a few emails an hour) and the email texts.
5. Fill in `config.js`: the project URL and the anon key (Settings → API). Both are public by
   design; what they can do is limited by the row level security.
6. Fill in the `[brackets]` in `privacy.html` and `terms.html` and have them checked.

Testing payments: with the `test_` key Mollie's checkout lets you choose the outcome (paid,
failed, …); the pass appears within seconds after "paid".

## Preferences

Personal preferences are on a screen of their own (**⚙** in the header, or the **Preferences**
line in either planner): piste colours, pace (for the day plan's
times), drag lifts and ski bus, plus the lifts avoided in this area. They are kept
on the phone for every ski area (`skirouter:prefs`), and with the account when accounts are on, and both planners use them. Done, or **⚙**
again, goes back to the planner; a quick route on screen is planned again with the new preferences.

Under the **Pace** switch each pace says what it means, the chosen one highlighted:
**Relaxed** about 7 km/h down the runs (piste times ×1.7) and ~7 min queueing per lift,
**Normal** about 9 km/h (×1.3) and ~5 min, **Sporty** about 12 km/h and ~3 min. The text is
worked out from `DAY_PACES` in `dayplan.js`, so it follows any change there.

### Difficulty and drag lifts

The colours picked under **Difficulty** and the **Drag lifts** switch are preferences, not hard
limits. A piste in another colour, or a
drag lift while the switch is off, costs an extra 120 minutes in the route search
(`UNWANTED_PENALTY`), so a route only takes one when there is no other way. It then says so
above the steps ("Not possible with only your choices, so this uses piste 21a (black)"). The day
planner only skis what you picked, but may use the rest on the way back when nothing else gets
you there, with the same warning. Lifts avoided by hand (above) stay a hard limit.

**Green** runs (OSM `novice`, used in France, Spain, Scandinavia, …) have their own colour; the
Green button only shows in areas that have them. North American double black diamonds do not
come up: the app covers European areas, where `expert` runs are black.

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
with a time for every step. Start, back-by time and kilometres sit on one line under
**🕘 Time & km**, folded to a summary ("09:00–16:00 · 25 km"). The options are only there when
their routes really differ (less than 60% of their pistes shared); one too much like another is
left out, and the line above them says what sets them apart: the route, and with lunch at
*best fit on my route* also a lunch spot of its own. Choosing one keeps them all in view;
**Fold ▴** puts them in one line with the chosen one, tap it to see them again. Above the steps there is
only one message, when the kilometres do not fit the time; closed lifts, lift hours, lunch and
the stops show at the steps themselves. Variety counts per marked piste: a descent through several runs
("31, 52") counts for each of them, so the same slope reached a slightly different way is not
"new" again, and runs without a number go by their name. Laps on one lift get less likely with
every ride, and more than three on the same lift cost the day's score. Times are a guideline: lift ride plus a queue that depends on the chosen pace,
and piste times stretched for short stops. The code is in `dayplan.js`.

With **Lunch** among the stops (and no other stops), the day becomes start → restaurant (around
the chosen time) → end. The planner tries every restaurant on the mountain that fits, or only the one picked
under *Where*, and says which one lies right on the route. It also lists other huts you pass
around lunchtime. Restaurants come from the OpenStreetMap enrichment below; places in the
villages are left out, as are places whose mapped opening hours do not cover your arrival.

### Following a route

In both planners you tap a step once you have done it. A tap also ticks every step before
it, so you can catch up after forgetting. Tap a ticked step to untick it and everything after
it. The quick route shows how many minutes are left. The day plan compares the clock with the
plan and shows whether you are on schedule, ahead or behind. **Replan from here** (hold a step
or swipe it left) plans the rest of the day again from that step, from now, with the km still
to go.
While you scroll through the steps, a bar stays at the top of the screen with **↑ Settings**,
**☰ List | 🗺 Map** and the progress: steps done, km and time still to go (and, in the day
plan, ahead or behind; **↻ Replan from here** is in the step menu, see below). The route's totals (km, pistes, lifts, back at) sit above it and
scroll away.
🗺 Map fills the screen below that bar, whatever the size of the phone: the bar goes to the top and
the map takes the rest (also after turning the phone). Going back from 🗺 Map to ☰ List shows the step you are at in the middle of the screen, the steps
just done above it, the same as after ticking a step.
Progress is stored on the phone, so a route being followed comes back when the app is
reopened. **Calculate route** and **Plan my day** start afresh with nothing ticked, also when
it is the same route as before.

When the delay carried through to the end of the day means getting back more than 10 minutes
after **Back by**, the day plan warns automatically (once a step is ticked, or within 90 minutes
of the first step; a plan looked at later without ticking anything is not being followed) (checked against the clock every minute, also
without tapping): a red bar in the sticky header and a warning above the steps, both with
**Replan from here**. The phone vibrates once when the warning first appears.

## OpenStreetMap enrichment

`tools/osm-enrich.mjs` adds restaurants and huts and lift opening hours, where mapped, to every
hand-made dataset in `data/areas.json` (built areas get theirs from the build). Only places on the piste are kept: within 80 m of a piste's course
(huts 100 m) or 130 m of a top station. A place within 130 m of a lift station is linked to that
station, otherwise to its piste. Piste ways more than 1.5 km from every lift belong to a
neighbouring area and are ignored.
It reads our own OpenStreetMap extract (`--osm`, see above), placed by the area's lift
stations and runs, and runs in GitHub Actions (`.github/workflows/osm-enrich.yml`) because
cloud sessions cannot reach Geofabrik: start it from **Actions → Enrich ski areas from OSM → Run
workflow**, or push a change to the script on a branch. The workflow commits the
updated data back to that branch.

## Previewing a change

Any static file server works, for example `npx serve .` or `python -m http.server`
inside a cloud session. Service workers need `http://localhost` or HTTPS.
