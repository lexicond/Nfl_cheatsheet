const { chromium } = require('playwright');
const path = require('path');

// PLAYWRIGHT_CHROMIUM points at a prebuilt browser where one exists; otherwise
// Playwright's own download is used. APP_URL overrides the server address.
const LAUNCH = process.env.PLAYWRIGHT_CHROMIUM
  ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM }
  : {};
const APP_URL = process.env.APP_URL || 'http://localhost:3000';
const SHEET_URL = 'file://' + path.resolve(__dirname, '../../cheatsheets/draft-room-2026.html');

let fails=0; const check=(n,c,d='')=>{console.log(`  ${c?'\x1b[32m✓\x1b[0m':'\x1b[31m✗\x1b[0m'} ${n}${d?' — '+d:''}`);if(!c)fails++};
(async () => {
  const b = await chromium.launch(LAUNCH);
  const p = await (await b.newContext({ viewport: { width: 1500, height: 900 } })).newPage();
  const errs=[]; p.on('pageerror',e=>errs.push(e.message));
  await p.goto(APP_URL, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1200);
  await p.click('button:text-is("Redraft")'); await p.waitForTimeout(800);
  const names = async n => (await p.locator('tbody tr td:nth-child(4)').allInnerTexts()).slice(0,n).map(t=>t.split('\n')[0].trim());
  const shown = () => p.locator('select option:checked').innerText();

  await p.selectOption('select', 'adp_sl_rd'); await p.waitForTimeout(800);
  check('sorting by Sleeper works', (await shown()) === 'Sleeper', await shown());
  await p.click('button[title*="Which sources"]'); await p.waitForTimeout(300);
  await p.click('#src-adp_sl_rd'); await p.waitForTimeout(1000);

  check('dropdown falls back to Consensus', (await shown()) === 'Consensus', await shown());
  const after = await names(6);
  // With Sleeper off the consensus is FantasyPros alone, so the board must match FP order.
  await p.selectOption('select', 'adp_fp_rd'); await p.waitForTimeout(800);
  const fpOrder = await names(6);
  check('board was in the new consensus order', JSON.stringify(after) === JSON.stringify(fpOrder),
    `${after.slice(0,3).join(',')} vs ${fpOrder.slice(0,3).join(',')}`);

  console.log('\nsorting by a source from another format is refused');
  await p.goto(APP_URL + '/api/players?format=RD&sort=ktc_value');
  const j = JSON.parse(await p.locator('body').innerText());
  check('KTC rejected in redraft', j.sort === 'adp_consensus', `server used "${j.sort}"`);
  await p.goto(APP_URL + '/api/players?format=DYN&sort=ktc_value');
  const j2 = JSON.parse(await p.locator('body').innerText());
  check('KTC accepted in dynasty', j2.sort === 'ktc_value', `server used "${j2.sort}"`);
  await p.goto(APP_URL + '/api/players?format=DYN&sort=ktc_value&exclude=ktc');
  const j3 = JSON.parse(await p.locator('body').innerText());
  check('KTC refused once switched off', j3.sort === 'adp_consensus', `server used "${j3.sort}"`);

  console.log('\nerrors:', errs.length?errs.slice(0,2):'none');
  if (errs.length) fails++;
  await b.close();
  console.log(`\n${fails===0?'\x1b[32mPASSED\x1b[0m':'\x1b[31m'+fails+' FAILED\x1b[0m'}\n`);
})();
