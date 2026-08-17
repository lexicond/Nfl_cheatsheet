# Tests

Two kinds, both run by hand — there is no CI.

## Node scripts (no browser, no dependencies)

```bash
node server/scripts/validate-sources.js    # each format contains what it claims
node server/scripts/test-source-toggle.js  # turning a source off changes the board
node server/scripts/audit-matching.js      # name-matching damage across sources
node server/scripts/health-check.js        # freshness, coverage, consistency
```

All four exit non-zero on failure. Run them after any refresh and after any change to
`server/sources.js`, `server/consensus.js` or a scraper.

## Browser suites

```bash
npm install --no-save playwright           # not a project dependency
npm --prefix client run build
node server/scripts/build-cheatsheet.js
node server/index.js &
bash tests/browser/run-all.sh
```

| Suite | Covers |
|---|---|
| `workflows.js` | The draft-day path: search, position filter, marking drafted and undoing it, starring, personal ranks, notes, format switching, and that overrides survive it all |
| `toggletest.js` | Source toggles in the app — consensus recomputes, columns follow, choices persist, the last source cannot be switched off |
| `verify1.js` | A sort key whose source is switched off falls back, and the dropdown never disagrees with the order on screen |
| `allviews.js` | All six format/league views at three league sizes, checking for console errors |
| `csnew.js` | Cheat sheet: defaults, sticky header, league size, sorting, Superflex persistence |
| `cstoggle.js` | Cheat sheet source toggles and hover explanations |
| `final.js` | Both themes at phone width, and that the page never scrolls sideways |

`APP_URL` overrides the server address; `PLAYWRIGHT_CHROMIUM` points at a prebuilt browser.

**These tests reset nothing.** Clear user overrides first or they fail on state left by a
previous run:

```bash
node -e "require('./server/db').db.prepare(\"UPDATE player_overrides SET personal_rank=NULL, tier=NULL, starred=0, flagged=0, drafted=0, note_personal=NULL\").run()"
```
