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
const check = (n, c, d = '') => { console.log(`  ${c ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); if (!c) fails++; };
(async () => {
  const b = await chromium.launch(LAUNCH);
  const ctx = await b.newContext({ viewport: { width: 1400, height: 1100 } });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(SHEET_URL);
  await p.waitForTimeout(600);

  const heads = async () => (await p.locator('#board thead th').allInnerTexts()).map(t => t.trim());
  const firstCons = async () => {
    const h = await heads(); const i = h.findIndex(x => /^(consensus|rank)$/i.test(x));
    return (await p.locator('#board tbody tr:not(.roundrow)').first().locator('td').allInnerTexts())[i]?.trim();
  };

  console.log('\nBest ball 1QB');
  check('source cards rendered', await p.locator('.srccard').count() === 2, `${await p.locator('.srccard').count()} cards`);
  check('lead text mentions the count', /\b2 of 2\b/.test(await p.locator('#src-lead').innerText()),
    (await p.locator('#src-lead').innerText()).slice(0, 60));
  const c0 = await firstCons();

  await p.hover('.srccard:first-child');
  await p.waitForTimeout(300);
  const tipVisible = await p.locator('.srccard:first-child .tip').isVisible();
  check('hover shows the explanation', tipVisible);
  console.log('    tip:', (await p.locator('.srccard:first-child .tip').innerText()).replace(/\n/g,' | ').slice(0,120));
  await p.screenshot({ path: process.argv[2] + '/cs-sources.png' });

  console.log('\nRedraft 1QB — toggling');
  await p.click('button:text-is("Redraft")'); await p.waitForTimeout(400);
  check('5 source cards', await p.locator('.srccard').count() === 5);
  check('ESPN is off by default', !(await heads()).includes('ESPN'), (await heads()).join(','));
  await p.click('input[data-src="esp"]'); await p.waitForTimeout(500);
  const rd0 = await firstCons(); const heads0 = await heads();
  check('enabling ESPN adds its column', (await heads()).includes('ESPN'));
  await p.click('input[data-src="esp"]'); await p.waitForTimeout(500);
  check('switching ESPN back off removes it', !(await heads()).includes('ESPN'));
  check('consensus recomputed', await firstCons() !== rd0, `${rd0} → ${await firstCons()}`);
  check('count line reflects the active count', /2 sources/.test(await p.locator('#count').innerText()), await p.locator('#count').innerText());
  await p.click('input[data-src="esp"]'); await p.waitForTimeout(500);
  check('toggling back restores', await firstCons() === rd0 && JSON.stringify(await heads()) === JSON.stringify(heads0));

  console.log('\nDynasty — rank-averaged sources');
  await p.click('button:text-is("Dynasty")'); await p.waitForTimeout(500);
  const dynOrder = async () => (await p.locator('#board tbody tr td:nth-child(2)').allInnerTexts()).slice(0, 15).map(t => t.split('\n')[0].trim());
  const dyn0 = await dynOrder();
  await p.click('input[data-src="ktc"]'); await p.waitForTimeout(500);
  // Compare the order, not one rounded number — the top player can keep his rank to
  // one decimal while the board below him reshuffles.
  check('dynasty board reorders on toggle', JSON.stringify(await dynOrder()) !== JSON.stringify(dyn0));
  check('KTC column removed', !(await heads()).includes('KTC'));
  await p.click('input[data-src="ktc"]'); await p.waitForTimeout(500);
  check('dynasty restores', JSON.stringify(await dynOrder()) === JSON.stringify(dyn0));

  console.log('\nLast source guard');
  await p.click('button:text-is("Best ball")'); await p.waitForTimeout(400);
  await p.click('input[data-src="ud"]'); await p.waitForTimeout(400);
  const remaining = p.locator('input[data-src="fpb"]');
  check('last remaining source is disabled', await remaining.isDisabled());
  await p.click('#src-reset'); await p.waitForTimeout(400);
  check('reset restores both', await p.locator('.srccard.off').count() === 0);
  check('reset restores consensus', await firstCons() === c0);

  console.log('\npersistence');
  await p.click('input[data-src="ud"]'); await p.waitForTimeout(400);
  await p.reload(); await p.waitForTimeout(700);
  check('choice survives reload', await p.locator('.srccard.off').count() === 1);

  console.log('\nerrors:', errs.length ? errs.slice(0,3) : 'none');
  if (errs.length) fails++;
  await b.close();
  console.log(`\n${fails === 0 ? 'ALL CHEAT SHEET TOGGLE TESTS PASSED' : fails + ' FAILED'}\n`);
  process.exit(fails ? 1 : 0);
})();
