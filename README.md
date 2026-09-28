# SkiRouter

Route planner for ski areas: pick a lift station, pick a destination, get the lifts and pistes to take.
Works on phone, tablet and laptop, and offline on the mountain once it has been opened.

## Published site (GitHub Pages)

Every push to `main` publishes the planner via `.github/workflows/pages.yml`.
Only the static planner goes online: `index.html`, `app.js`, `styles.css`, `sw.js`,
`manifest.webmanifest`, `icons/` and `data/`. The server and the admin page stay local.

**One-time setup**
1. Create an empty repository on github.com (no README, no .gitignore).
2. Push this folder to it (see the commands below).
3. In the repository: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
4. After the first run (tab **Actions**) the site is at `https://<your-username>.github.io/<repository>/`.

**On your phone:** open the site, then
- iPhone (Safari): Share → **Add to Home Screen**
- Android (Chrome): menu → **Install app** / **Add to Home screen**

Open it once with a connection; after that the planner and all ski areas work without a signal.

## Adding or updating a ski area

1. Generate the dataset with the `skimap-osm` skill (writes `data/<id>.json` and registers it in `data/areas.json`).
2. Commit and push. The site updates itself; phones pick up the new data the next time they open the app with a connection.

If you change the list of files the app needs offline, bump `CACHE_VERSION` in `sw.js`.

## Running locally (with the admin page)

```
npm install
npm start
```

Then open http://localhost:3000. The "Manage ski areas" link only appears when this local server runs.
