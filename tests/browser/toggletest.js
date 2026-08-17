const { chromium } = require('playwright');
const path = require('path');

// PLAYWRIGHT_CHROMIUM points at a prebuilt browser where one exists; otherwise
// Playwright's own download is used. APP_URL overrides the server address.
const LAUNCH = process.env.PLAYWRIGHT_CHROMIUM
  ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM }
  : {};
const APP_URL = process.env.APP_URL || 'http://localhost:3000';
const SHEET_URL = 'file://' + path.resolve(__dirname, '../../cheatsheets/draft-room-2026.html');

let fails = 0;
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) fails++;
};

(async () => {
  const b = await chromium.launch(LAUNCH);
  const ctx = await b.newContext({ viewport: { width: 1500, height: 1000 } });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));

  const openPanel = async () => {
    const expanded = await p.locator('button[title*="Which sources"]').getAttribute('aria-expanded');
    if (expanded !== 'true') { await p.click('button[title*="Which sources"]'); await p.waitForTimeout(300); }
  };
  const badge = () => p.locator('button[title*="Which sources"]').innerText();
  const headerCols = async () => (await p.locator('thead th').allInnerTexts()).map(t => t.trim());
  const topRows = async (n = 5) => (await p.locator('tbody tr').allInnerTexts()).slice(0, n).map(t => t.replace(/\s+/g, ' '));
  const consensusOf = async (rowIdx = 0) => {
    const cols = await headerCols();
    const ci = cols.findIndex(c => c === 'CONSENSUS' || c === 'RANK');
    const cells = await p.locator('tbody tr').nth(rowIdx).locator('td').allInnerTexts();
    return cells[ci]?.trim();
  };

  await p.goto(APP_URL, { waitUntil: 'networkidle' });
  await p.waitForTimeout(900);
  await p.click('button:text-is("Redraft")');
  await p.waitForTimeout(700);

  console.log('\nRedraft 1QB — toggle a source off and on');
  let cols0 = await headerCols();
  let cons0 = await consensusOf();
  let order0 = await topRows(8);
  // Defaults now ship with FFC, ESPN and Yahoo off, so switch them on before testing
  // that a toggle changes the board.
  await openPanel();
  await p.click('button:has-text("Turn every source on")');
  await p.waitForTimeout(900);
  check('turning everything on gives 5 sources', (await badge()).includes('5/5'), (await badge()).replace(/\n/g, ' '));
  check('ESPN column present once enabled', (await headerCols()).includes('ESPN'));

  cons0 = await consensusOf();
  order0 = await topRows(8);
  await openPanel();
  await p.click('#src-adp_espn');
  await p.waitForTimeout(800);
  const cols1 = await headerCols();
  const cons1 = await consensusOf();
  check('badge drops to 4/5', (await badge()).includes('4/5'));
  check('ESPN column removed', !cols1.includes('ESPN'));
  check('consensus recomputed', cons0 !== cons1, `${cons0} → ${cons1}`);

  await p.click('#src-adp_espn');
  await p.waitForTimeout(800);
  check('toggling back restores consensus', (await consensusOf()) === cons0, `${await consensusOf()} vs ${cons0}`);
  check('toggling back restores column', (await headerCols()).includes('ESPN'));
  check('toggling back restores order', JSON.stringify(await topRows(8)) === JSON.stringify(order0));

  console.log('\nOrdering actually changes when a source is dropped');
  await openPanel();
  await p.click('#src-adp_ffc');
  await p.click('#src-adp_sl_rd');
  await p.waitForTimeout(900);
  const order2 = await topRows(12);
  check('board reorders on 2 sources removed', JSON.stringify(order2) !== JSON.stringify(await topRows(12).then(() => order0.slice(0, 12))), 'compared top 12');
  check('badge shows 3/5', (await badge()).includes('3/5'));

  console.log('\nExclusions persist across a reload');
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForTimeout(1000);
  check('still 3/5 after reload', (await badge()).includes('3/5'), (await badge()).replace(/\n/g, ' '));
  check('excluded columns still hidden', !(await headerCols()).includes('FFC'));

  console.log('\nA source stays off when Superflex is toggled');
  await p.click('button:text-is("SF/2QB")');
  await p.waitForTimeout(900);
  const sfCols = await headerCols();
  check('superflex board also drops the switched-off markets', !sfCols.includes('FFC SF'), sfCols.join(','));
  await p.click('button:text-is("1QB")');
  await p.waitForTimeout(900);
  check('redraft exclusions still remembered', (await badge()).includes('3/5'), (await badge()).replace(/\n/g, ' '));

  console.log('\nReset restores everything');
  await openPanel();
  await p.click('button:has-text("Turn every source on")');
  await p.waitForTimeout(900);
  check('turning everything on returns to 5/5', (await badge()).includes('5/5'));
  check('reset restores consensus', (await consensusOf()) === cons0, `${await consensusOf()} vs ${cons0}`);

  console.log('\nLast source cannot be switched off');
  await openPanel();
  for (const c of ['adp_ffc', 'adp_fp_rd', 'adp_sl_rd', 'adp_espn']) {
    await p.click(`#src-${c}`).catch(() => {});
    await p.waitForTimeout(500);
    await openPanel();
  }
  check('one source left', (await badge()).includes('1/5'), (await badge()).replace(/\n/g, ' '));
  const lastDisabled = await p.locator('#src-adp_yahoo').isDisabled();
  check('remaining source checkbox is disabled', lastDisabled);

  console.log('\nDynasty reference source hides column without changing the rank');
  await p.click('button:text-is("Dynasty")');
  await p.waitForTimeout(900);
  const dynRank = await consensusOf();
  const dynCols = await headerCols();
  check('DynastyProcess shown as a column', dynCols.includes('DP'), dynCols.join(','));
  await openPanel();
  await p.click('#src-dp_value');
  await p.waitForTimeout(800);
  check('DP column removed', !(await headerCols()).includes('DP'));
  check('dynasty rank unchanged (DP is not averaged)', (await consensusOf()) === dynRank, `${await consensusOf()} vs ${dynRank}`);

  console.log('\nerrors:', errs.length ? errs.slice(0, 3) : 'none');
  if (errs.length) fails++;
  await b.close();
  console.log(`\n${fails === 0 ? '\x1b[32mALL TOGGLE TESTS PASSED\x1b[0m' : `\x1b[31m${fails} FAILED\x1b[0m`}\n`);
  process.exit(fails ? 1 : 0);
})();
