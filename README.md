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

Only the planner files go online: `index.html`, `dayplan.js`, `app.js`, `styles.css`, `sw.js`,
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

The OSM enrichment stores every station's coordinates (`coordOnder` / `coordBoven`) and the
nearest named bus stop (`bushalte`), which help to work out a sensible `tijd`.

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
reopened.

## OpenStreetMap enrichment

`tools/osm-enrich.mjs` adds restaurants and huts (linked to the nearest lift station or
piste) and lift opening hours, where mapped, to every dataset in `data/areas.json`.
It runs in GitHub Actions (`.github/workflows/osm-enrich.yml`) because cloud sessions
cannot reach OpenStreetMap: start it from **Actions → Enrich ski areas from OSM → Run
workflow**, or push a change to the script on a branch. The workflow commits the
updated data back to that branch.

## Previewing a change

Any static file server works, for example `npx serve .` or `python -m http.server`
inside a cloud session. Service workers need `http://localhost` or HTTPS.
