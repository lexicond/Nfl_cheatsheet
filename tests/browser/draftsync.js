// Live Sleeper draft sync, driven through the real UI.
//
// The connected state is seeded straight into the database from a real Sleeper draft
// rather than mocked, so the rows under test are genuine picks. The initial page load
// reads /api/draft/state?sync=0, which is exactly the path a reload mid-draft takes.
//
//   node tests/browser/draftsync.js
//
// APP_URL overrides the server address; PLAYWRIGHT_CHROMIUM points at a prebuilt browser.

const { chromium } = require('playwright');
const path = require('path');

const APP_URL = process.env.APP_URL || 'http://localhost:3000';
const { db } = require(path.join(__dirname, '..', '..', 'server', 'db'));
const { fetchDraft, fetchPicks } = require(path.join(__dirname, '..', '..', 'server', 'scrapers', 'sleeperDraft'));
const draftRoutes = require(path.join(__dirname, '..', '..', 'server', 'routes', 'draft'));

// A real, finished, public draft. Its season is overridden below so the board treats
// it as the current one — the season guard itself is covered by validate-draft-sync.js.
const FIXTURE_DRAFT = '650130288072040449';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

async function seedConnectedDraft() {
  const meta = await fetchDraft(FIXTURE_DRAFT, '2021');
  const picks = await fetchPicks(FIXTURE_DRAFT);

  db.prepare('DELETE FROM draft_picks').run();
  db.prepare('DELETE FROM draft_sync').run();
  db.prepare(`
    INSERT INTO draft_sync (
      id, draft_id, status, type, season, scoring_type, league_id, league_name,
      teams, rounds, reversal_round, my_user_id, my_display_name, my_slot,
      team_names, draft_order, connected_at, last_synced
    ) VALUES (
      1, @draft_id, 'drafting', @type, @season, @scoring_type, @league_id, @league_name,
      @teams, @rounds, 0, @my_user_id, 'Test Owner', @my_slot,
      @team_names, @draft_order, datetime('now'), datetime('now')
    )
  `).run({
    draft_id: meta.draft_id,
    type: meta.type,
    season: meta.season,
    scoring_type: meta.scoring_type,
    league_id: meta.league_id,
    league_name: meta.league_name,
    teams: meta.teams,
    rounds: meta.rounds,
    my_user_id: Object.keys(meta.draft_order)[0],
    my_slot: meta.draft_order[Object.keys(meta.draft_order)[0]],
    team_names: JSON.stringify({ [Object.keys(meta.draft_order)[0]]: 'Test Owner' }),
    draft_order: JSON.stringify(meta.draft_order),
  });

  // Only the first half of the picks, so the draft reads as still running.
  const partial = picks.filter(p => p.pick_no <= 20);
  const stored = draftRoutes.storePicks(meta.draft_id, partial);
  return { meta, picks, partial, stored };
}

function clearDraft() {
  db.prepare('DELETE FROM draft_picks').run();
  db.prepare('DELETE FROM draft_sync').run();
}

(async () => {
  const seeded = await seedConnectedDraft();
  console.log(`Seeded ${seeded.partial.length} picks (${seeded.stored.matched} matched onto the board)\n`);

  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined,
  });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

  // The page pulls its webfonts from Google. That request fails in a sandbox with no
  // outbound access and has nothing to do with the draft, so only the app's own
  // failures count here.
  const consoleErrors = [];
  const external = url => /fonts\.(googleapis|gstatic)\.com/.test(url || '');
  page.on('console', m => {
    if (m.type() === 'error' && !external(m.location()?.url)) consoleErrors.push(m.text());
  });
  page.on('pageerror', e => consoleErrors.push(e.message));
  page.on('requestfailed', r => {
    if (!external(r.url())) consoleErrors.push(`${r.url()} — ${r.failure()?.errorText}`);
  });

  try {
    // --- The board with a draft already under way -----------------------------
    await page.goto(APP_URL, { waitUntil: 'networkidle' });
    await page.waitForSelector('table tbody tr', { timeout: 20000 });

    const drafted = seeded.partial
      .map(p => [p.metadata?.first_name, p.metadata?.last_name].filter(Boolean).join(' '))
      .filter(Boolean);

    check('page renders with a draft connected', await page.locator('table tbody tr').count() > 0);

    // Hide Drafted is on by default, so every taken player should be gone.
    const bodyText = await page.locator('table tbody').innerText();
    const stillShowing = drafted.filter(n => bodyText.includes(n));
    check('players taken in the draft are off the board', stillShowing.length === 0,
      stillShowing.length ? `still showing: ${stillShowing.slice(0, 3).join(', ')}` : '');

    // --- The panel's own state -----------------------------------------------
    const pill = page.locator('button', { hasText: 'Draft' }).first();
    check('draft pill shows the pick count', (await pill.innerText()).includes(String(seeded.partial.length)));

    await pill.click();
    await page.waitForTimeout(300);
    const panel = await page.locator('text=Live Sleeper draft').first().isVisible();
    check('panel opens', panel);

    const panelText = await page.locator('div.absolute').first().innerText();
    check('panel names the league', panelText.includes(seeded.meta.league_name));
    check('panel shows the latest pick', panelText.includes('Latest picks'));
    check('panel shows who is on the clock', /on the clock/i.test(panelText));

    // The draft is 10-team; the board defaults to 12, so the offer to match should show.
    check('offers to match the board to the draft size',
      /match the draft/i.test(panelText), panelText.split('\n').slice(0, 6).join(' | '));

    await page.keyboard.press('Escape');

    // --- Picks landing while you watch ---------------------------------------
    // The feature's whole claim: a player taken in the room leaves the board without
    // anyone reloading anything. Only the first twenty picks were seeded, so the poll
    // has to pull the rest from Sleeper itself and carry them through to the rows on
    // screen — no synthetic pick is injected, this is the live path end to end.
    const boardBefore = await page.locator('table tbody').innerText();
    const later = seeded.picks
      .filter(p => p.pick_no > seeded.partial.length)
      .map(p => ({ pick_no: p.pick_no, name: [p.metadata?.first_name, p.metadata?.last_name].filter(Boolean).join(' ') }))
      .filter(p => p.name && boardBefore.includes(p.name));

    check('players yet to be taken are on the board', later.length > 0,
      later.slice(0, 3).map(p => `${p.pick_no} ${p.name}`).join(', '));

    await page.waitForTimeout(8000);   // two poll ticks at five seconds

    check('the pick count moves on its own',
      (await pill.innerText()).includes(String(seeded.picks.length)),
      `pill reads ${JSON.stringify(await pill.innerText())}`);

    const boardAfter = await page.locator('table tbody').innerText();
    const lingering = later.filter(p => boardAfter.includes(p.name));
    check('players taken since leave the board without a reload', lingering.length === 0,
      lingering.length ? `still showing: ${lingering.slice(0, 3).map(p => p.name).join(', ')}` : `${later.length} left the board`);

    // --- Taken players, shown with the pick that took them --------------------
    await page.locator('input[type="checkbox"]').first().uncheck();   // Hide Drafted off
    await page.waitForTimeout(800);
    const withDrafted = await page.locator('table tbody').innerText();
    check('unhiding brings taken players back', drafted.some(n => withDrafted.includes(n)));
    check('the pick number is shown against them', /#\d+/.test(withDrafted));

    // --- Disconnecting puts everyone back ------------------------------------
    await pill.click();
    await page.waitForTimeout(200);
    await page.locator('button', { hasText: 'Disconnect' }).first().click();
    await page.waitForTimeout(1200);

    const afterText = await page.locator('table tbody').innerText();
    check('disconnect restores the picked players as available',
      !/#\d+\s/.test(await page.locator('table tbody').innerText()) || afterText.includes('Available'));
    check('draft pill reads off', (await pill.innerText()).toLowerCase().includes('off'));

    check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));
  } catch (err) {
    check('suite ran to completion', false, err.message);
  } finally {
    await browser.close();
    clearDraft();
  }

  console.log(failures === 0 ? '\nAll draft-sync checks passed' : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
})();
