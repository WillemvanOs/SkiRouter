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

Only the planner files go online: `index.html`, `app.js`, `styles.css`, `sw.js`,
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
To remove an area, delete its file and its entry in `data/areas.json`.

Each entry in `data/areas.json` points to its data file via `file`; the service worker
pre-caches every file listed there. Phones pick up new data the next time they open
the app with a connection.

If you change the list of app files the planner needs offline, bump `CACHE_VERSION` in `sw.js`.

## Previewing a change

Any static file server works, for example `npx serve .` or `python -m http.server`
inside a cloud session. Service workers need `http://localhost` or HTTPS.
