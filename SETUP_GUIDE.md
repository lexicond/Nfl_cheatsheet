# Setup Guide — From Phone to Live App

Everything you need to go from zero to a live draft board, done entirely from your phone.

---

## What you'll need

- GitHub account (free)
- Railway account (free) — sign up at railway.app with your GitHub account
- About 10 minutes

---

## Part 1 — Railway Account

1. Open your phone browser and go to **railway.app**
2. Tap **"Login"** → **"Login with GitHub"**
3. Authorize Railway when prompted
4. You're in. Railway's free tier gives you $5/month of credit — more than enough for a personal tool that sleeps when idle.

---

## Part 2 — Create the Project on Railway

1. From the Railway dashboard, tap **"New Project"**
2. Select **"Deploy from GitHub repo"**
3. If this is your first time, tap **"Configure GitHub App"** and authorize Railway to access your repos
4. Search for and select **`Nfl_cheatsheet`**
5. Railway will detect the `railway.json` automatically — tap **"Deploy Now"**

> Railway will now run `npm run build` (builds the React frontend) then `npm start`. The first deploy takes ~2 minutes.

---

## Part 3 — Add a Persistent Volume (Critical!)

> ⚠️ **Without this step, all your personal rankings, tiers, notes, and star/flag markings will be permanently deleted every time you deploy a code update.** The app currently writes the database to the container's ephemeral storage, which is wiped on every new deploy. This has not caused data loss yet because no redeployment has occurred — but your first code change will erase everything. Set up the volume now, before entering any personal data.

This is what keeps your personal rankings and notes alive across deploys and sleep cycles. **Do this before your first visit to the app.**

1. In your Railway project, tap on the service tile (it'll be called something like `Nfl_cheatsheet`)
2. Scroll down to the **"Volumes"** section (or tap the **"+"** button and choose "Volume")
3. Tap **"Add Volume"**
4. Set the mount path to exactly: `/data`
5. Tap **"Create"**

Railway will re-deploy automatically after adding the volume. Wait for the green "Active" status (~1 minute).

Once the volume is attached, the database lives at `/data/draft.db` and survives all future deploys.

---

## Part 4 — Get Your App URL

1. In the service view, tap the **"Settings"** tab
2. Under **"Domains"**, tap **"Generate Domain"**
3. Railway gives you a free `.railway.app` URL — copy it
4. Open that URL in your browser

---

## Part 5 — First Launch

On first load, the app will automatically try to fetch player data from Sleeper's public API. You'll see:

> *"Populating player data… Fetching from Sleeper API on first run"*

This takes about 10–15 seconds and seeds ~1,500 skill-position players with ADP data.

Once loaded, you'll see the full board sorted by consensus ADP.

---

## Part 6 — Refresh the Other Data Sources

Sleeper loads automatically, but FantasyPros and Underdog need a manual first refresh:

1. In the top-right of the app, find the source panel: **FantasyPros · Underdog · Sleeper**
2. Tap **"Refresh All"** (or tap ↻ next to each source individually)
3. Wait 15–30 seconds — the timestamps will update to "just now"

> If FantasyPros or Underdog show ⚠ Failed, that's normal — their sites occasionally block automated requests. Sleeper data is always solid.

---

## Part 7 — Bookmark It

Add the app to your phone's home screen for quick access during draft season:

**iPhone (Safari):** Tap the Share icon → "Add to Home Screen"  
**Android (Chrome):** Tap the three dots → "Add to Home Screen"

---

## You're live. Here's what you can do:

| Action | How |
|---|---|
| Set personal rank | Tap the "My #" cell and type |
| Reorder a player | Drag the ⠿ handle (works on mobile with a long press) |
| Add notes / set tier | Tap 📝 on any player row |
| Star a player | Tap ★ in the Flags column |
| Mark as drafted | Tap "Available" to toggle to "✓ Drafted" |
| Filter by position | Tap the QB / RB / WR / TE pills at the top |
| Refresh ADP data | Tap ↻ next to a source, or "Refresh All" |
| Close the notes panel | Tap outside it, or press Esc (desktop) |

---

## Coming back tomorrow (after Railway sleep)

Railway free tier sleeps services after ~10 minutes of inactivity. When you reopen the app:

- First request wakes it up (~5–10 second cold start)
- **All your personal rankings, notes, tiers, and starred players are saved** in the `/data` volume
- Nothing is lost

---

## Troubleshooting

**App shows blank / loading forever**
- Check Railway dashboard — the service may have crashed. Tap "View Logs" to see the error.

**"Populating player data" is stuck**
- The Sleeper API call may have timed out. Tap the ↻ next to "Sleeper" in the refresh panel to retry.

**FantasyPros shows ⚠ Failed every time**
- Their site blocks scrapers intermittently. Your Sleeper + Underdog data is still usable. Try again in a few hours or the next day.

**Personal rankings disappeared**
- This means the app deployed without a volume attached. Go to Railway → Volumes → Add Volume → `/data`, then re-deploy. Rankings can't be recovered without the volume file.

**Want to update the app after code changes**
- Just push to the `main` branch on GitHub. Railway auto-deploys within ~2 minutes.
