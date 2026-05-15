# Getting the crew share view onto a phone

Three paths, in order of effort:

## 1. AirDrop / email the standalone HTML to your phone (fastest)

1. Planner → **Share & go live** panel → **⬇ Export as standalone HTML**.
2. AirDrop / email / Drive the downloaded `.html` file to your phone.
3. Open the file in mobile Safari / Chrome.

The exported HTML now uses a **non-module IIFE bundle** (v4.6+) — no
`type="module"` script tags, no importmap, no data-URI modules. Works on
in-app browsers, older OS versions, and file:// origins. Internet is only
needed once on first open (Leaflet tiles + Alpine + Chart.js CDN); after
that it's cached.

**Limitations:**
- 3D route profile is **excluded** from the standalone bundle (Three.js
  is ESM-only since r150). 2D map, ETA list, nutrition table, and the
  Elevation / Per-segment / Cumulative pace charts all ship.

If this works for crew, you're done.

---

## 2. Drop the folder onto Netlify Drop (URL in 30 seconds, no GitHub)

1. Open https://app.netlify.com/drop
2. Drag the entire `Trail-Planner-V4` folder into the page.
3. Netlify gives you a random URL like `https://something.netlify.app/`.
4. Share URLs:
   - **Planner**: that URL.
   - **Share view**: `that-url/share.html?runId=<id>&token=<token>` —
     but note crew's phones will have **empty localStorage** for the
     planner origin, so the runId/token won't resolve. Use option 1
     (export standalone) and upload it as a separate file (e.g.
     `crew-uta-2026.html`) — then share `that-url/crew-uta-2026.html`.

---

## 3. GitHub Pages auto-deploy (free, permanent URL)

Workflow lives at `.github/workflows/pages.yml`. To set up:

```bash
cd Trail-Planner-V4
git init
git add .
git commit -m "Initial V4"
git branch -M main
git remote add origin git@github.com:<your-user>/trail-planner-v4.git
git push -u origin main
```

Then on GitHub:
1. Repo **Settings → Pages**.
2. **Source**: select **GitHub Actions**.
3. The workflow runs on every push to `main` and deploys the whole
   folder.
4. Site goes live at `https://<your-user>.github.io/trail-planner-v4/`.

To share the crew view:
- Export a standalone HTML in the planner (`⬇ Export as standalone HTML`).
- Drop the downloaded file into `Trail-Planner-V4/` (e.g. as
  `crew-uta-2026.html`).
- `git add crew-uta-2026.html && git commit -m "Crew share" && git push`.
- ~1 minute later it's live at
  `https://<your-user>.github.io/trail-planner-v4/crew-uta-2026.html`.

You can re-export and re-push whenever the plan changes; the URL stays
the same for crew.

---

## 4. Phase 5 — Firebase Hosting + Firestore (the real plan)

The originally-specced path: store run docs in Firestore, serve the
planner from Firebase Hosting, and the share URL works on any device
without the runner having pre-shared the standalone HTML. The store
adapter (`src/share/storeFirebase.js`) is the swap-in point. Not yet
implemented — Phase 5.
