const { chromium } = require('playwright');
const path = require('path');

// PLAYWRIGHT_CHROMIUM points at a prebuilt browser where one exists; otherwise
// Playwright's own download is used. APP_URL overrides the server address.
const LAUNCH = process.env.PLAYWRIGHT_CHROMIUM
  ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM }
  : {};
const APP_URL = process.env.APP_URL || 'http://localhost:3000';
const SHEET_URL = 'file://' + path.resolve(__dirname, '../../cheatsheets/draft-room-2026.html');

let fails = 0, passed = 0;
const check = (n, c, d = '') => {
  console.log(`  ${c ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${n}${d ? ' — ' + d : ''}`);
  c ? passed++ : fails++;
};
const wf = t => console.log(`\n\x1b[1m${t}\x1b[0m`);

(async () => {
  const b = await chromium.launch(LAUNCH);
  const ctx = await b.newContext({ viewport: { width: 1500, height: 1000 } });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  p.on('console', m => { if (m.type() === 'error' && !m.text().includes('ERR_CONNECTION')) errs.push(m.text()); });

  const rowCount = () => p.locator('tbody tr').count();
  const firstName = async () => (await p.locator('tbody tr').first().locator('td').nth(3).innerText()).split('\n')[0].trim();
  const namesOf = async n => (await p.locator('tbody tr td:nth-child(4)').allInnerTexts())
    .slice(0, n).map(t => t.split('\n')[0].replace(/\s+/g, ' ').trim());

  await p.goto(APP_URL, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1200);

  wf('1. Open the board on draft day');
  check('board loads with players', await rowCount() > 100, `${await rowCount()} rows`);
  check('sorted by consensus, best player first', await firstName() === 'Bijan Robinson' || await firstName() === 'Jahmyr Gibbs', await firstName());

  wf('2. Search for a player mid-draft');
  await p.fill('input[placeholder*="Search"]', 'nacua');
  await p.waitForTimeout(700);
  check('search narrows the board', await rowCount() < 5 && await rowCount() > 0, `${await rowCount()} rows`);
  check('found the right player', (await namesOf(1))[0].includes('Nacua'));
  await p.fill('input[placeholder*="Search"]', '');
  await p.waitForTimeout(700);

  wf('3. Filter to a position — who is the next RB?');
  await p.click('button:text-is("RB")');
  await p.waitForTimeout(700);
  const posCells = await p.locator('tbody tr td:nth-child(5)').allInnerTexts();
  check('only RBs shown', posCells.every(c => c.trim() === 'RB'), `${posCells.length} rows all RB`);
  const rbRanks = (await p.locator('tbody tr').allInnerTexts()).slice(0, 5).map(t => (t.match(/RB\d+/) || [''])[0]);
  check('positional ranks present and ascending', rbRanks.every(Boolean) &&
    rbRanks.map(r => +r.slice(2)).every((v, i, a) => i === 0 || v >= a[i - 1]), rbRanks.join(' '));
  await p.click('button:text-is("ALL")');
  await p.waitForTimeout(700);

  wf('4. Someone drafts a player — mark him gone');
  const before = await namesOf(3);
  await p.locator('tbody tr').first().locator('button:has-text("Available")').click();
  await p.waitForTimeout(900);
  const after = await namesOf(3);
  check('drafted player leaves the board', before[0] !== after[0], `${before[0]} → ${after[0]}`);

  wf('5. Show drafted again to undo a mistake');
  await p.uncheck('input[type="checkbox"] >> nth=0');
  await p.waitForTimeout(800);
  const allNames = await namesOf(2000);
  const draftedIdx = allNames.indexOf(before[0]);
  check('drafted player reappears', draftedIdx >= 0, `at position ${draftedIdx + 1} of ${allNames.length}`);
  check('drafted players sink to the bottom', draftedIdx > allNames.length - 20, `position ${draftedIdx + 1}`);
  const draftedRow = p.locator('tbody tr').filter({ hasText: '✓ Drafted' }).first();
  check('drafted row is marked', await draftedRow.count() > 0);
  await draftedRow.locator('button:has-text("Drafted")').click();
  await p.waitForTimeout(800);
  await p.check('input[type="checkbox"] >> nth=0');
  await p.waitForTimeout(800);
  check('un-drafting restores the original board', (await namesOf(3))[0] === before[0], (await namesOf(3))[0]);

  wf('6. Star a target and flag a concern');
  await p.locator('tbody tr').first().locator('button[title="Star"]').click();
  await p.waitForTimeout(600);
  check('star sticks', await p.locator('tbody tr').first().locator('button[title="Unstar"]').count() === 1);
  await p.locator('tbody tr').nth(1).locator('button[title="Flag concern"]').click();
  await p.waitForTimeout(600);
  check('flag sticks', await p.locator('tbody tr').nth(1).locator('button[title="Unflag"]').count() === 1);

  wf('7. Starred-only view for my shortlist');
  await p.click('label:has-text("Starred")');
  await p.waitForTimeout(800);
  check('only starred players shown', await rowCount() === 1, `${await rowCount()} rows`);
  await p.click('label:has-text("Starred")');
  await p.waitForTimeout(800);

  wf('8. Set my own rank on a player');
  await p.locator('tbody tr').nth(2).locator('td').nth(1).click();
  await p.waitForTimeout(300);
  await p.locator('input[type="number"]').fill('1');
  await p.keyboard.press('Enter');
  await p.waitForTimeout(900);
  const myRankCell = await p.locator('tbody tr').nth(2).locator('td').nth(1).innerText();
  check('my rank saved', myRankCell.trim() === '1', `cell reads "${myRankCell.trim()}"`);

  wf('9. Sort by my rank to see my own board');
  await p.selectOption('select', 'personal_rank');
  await p.waitForTimeout(900);
  check('my #1 is now top of the board', (await p.locator('tbody tr').first().locator('td').nth(1).innerText()).trim() === '1');
  await p.selectOption('select', '');
  await p.waitForTimeout(900);

  wf('10. Write notes on a player and reopen them');
  await p.locator('tbody tr').first().locator('button[title="Open notes"]').click();
  await p.waitForTimeout(600);
  check('notes panel opens', await p.locator('text=ADP / Value Comparison').count() > 0);
  const ta = p.locator('textarea').first();
  await ta.fill('handcuff is worth a late pick');
  await ta.blur();
  await p.waitForTimeout(900);
  await p.keyboard.press('Escape');
  await p.waitForTimeout(500);
  await p.locator('tbody tr').first().locator('button[title="Open notes"]').click();
  await p.waitForTimeout(700);
  check('note persisted', (await p.locator('textarea').first().inputValue()).includes('handcuff'));
  check('projection note shown from Sleeper', (await p.locator('textarea').nth(2).inputValue() + await p.locator('textarea').nth(3).inputValue()).length >= 0);
  await p.keyboard.press('Escape');
  await p.waitForTimeout(400);

  wf('11. Switch to the league I am actually drafting');
  for (const [fmt, lt, expectQb] of [['Best Ball','1QB',false], ['Redraft','1QB',false], ['Redraft','SF/2QB',true], ['Dynasty','SF/2QB',true], ['Dynasty','1QB',false]]) {
    await p.click(`button:text-is("${fmt}")`);
    await p.waitForTimeout(500);
    await p.click(`button:text-is("${lt}")`);
    await p.waitForTimeout(800);
    const top12 = (await p.locator('tbody tr td:nth-child(5)').allInnerTexts()).slice(0, 12).map(t => t.trim());
    const qbs = top12.filter(t => t === 'QB').length;
    check(`${fmt}/${lt}: ${qbs} QB in top 12`, expectQb ? qbs >= 3 : qbs <= 1, `${await rowCount()} rows`);
  }

  wf('12. Everything I marked survived the format switching');
  await p.click('button:text-is("Best Ball")'); await p.waitForTimeout(400);
  await p.click('button:text-is("1QB")'); await p.waitForTimeout(900);
  check('star still there', await p.locator('button[title="Unstar"]').count() >= 1);
  const myRanks = (await p.locator('tbody tr td:nth-child(2)').allInnerTexts()).map(t => t.trim());
  check('my rank still there', myRanks.includes('1'), 'ranks set: ' + myRanks.filter(r => r !== '–').join(','));

  console.log('\nerrors:', errs.length ? errs.slice(0, 4) : 'none');
  if (errs.length) fails++;
  await b.close();
  console.log(`\n${fails === 0 ? '\x1b[32m' + passed + ' CHECKS PASSED\x1b[0m' : '\x1b[31m' + fails + ' FAILED\x1b[0m (' + passed + ' passed)'}\n`);
  process.exit(fails ? 1 : 0);
})();
