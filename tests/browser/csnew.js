const { chromium } = require('playwright');
const path = require('path');
const { viewSources } = require('../../server/sources');

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
  const ctx = await b.newContext({ viewport: { width: 1500, height: 900 } });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(SHEET_URL);
  await p.waitForTimeout(700);

  const heads = async () => (await p.locator('#board thead th').allInnerTexts()).map(t=>t.trim());
  console.log('\nDefaults');
  check('only default sources shown', !(await heads()).includes('FFC'), (await heads()).join('|'));
  // Counted from the registry rather than hardcoded, for the same reason cstoggle is:
  // a literal here means every new source column breaks this suite for a reason that has
  // nothing to do with what the suite is testing.
  const bbCards = (() => {
    const v = viewSources('BB', '1QB');
    return v.consensus.length + v.reference.length;
  })();
  check('source cards match the registry', await p.locator('.srccard').count() === bbCards,
    `${await p.locator('.srccard').count()} cards, registry says ${bbCards}`);
  check('Δ SL column present', (await heads()).some(h=>/SL/.test(h)));
  check('Split column present', (await heads()).includes('SPLIT'));
  check('Rd column present', (await heads()).includes('RD'));

  console.log('\nSticky header');
  await p.locator('.board-scroll').scrollIntoViewIfNeeded();
  await p.waitForTimeout(300);
  const y0 = (await p.locator('#board thead th').first().boundingBox()).y;
  await p.locator('.board-scroll').evaluate(el => { el.scrollTop = 3000; });
  await p.waitForTimeout(500);
  const y1 = (await p.locator('#board thead th').first().boundingBox()).y;
  check('header still on screen after scrolling', y1 >= 0 && y1 < 900, `y ${Math.round(y0)} -> ${Math.round(y1)}`);
  // Column headings are what you need while scrolling; the round is on every row in
  // the Rd column, so orientation never depends on a divider being on screen.
  const rowInfo = await p.evaluate(() => {
    const pane = document.querySelector('.board-scroll').getBoundingClientRect();
    const rows = [...document.querySelectorAll('tr:not(.roundrow)')].filter(r => {
      const b = r.getBoundingClientRect();
      return b.y > pane.y + 30 && b.y < pane.y + 200 && r.querySelector('td');
    });
    return rows.slice(0, 2).map(r => [...r.querySelectorAll('td')].map(td => td.textContent.trim()));
  });
  const heads2 = await heads();
  const rdIdx = heads2.indexOf('RD');
  check('visible rows still show their round', rowInfo.length > 0 && rowInfo[0][rdIdx] !== '',
    `rows on screen show Rd=${rowInfo.map(r => r[rdIdx]).join(',')}`);
  check('single table for the whole board', await p.locator('#board table').count() === 1);
  await p.screenshot({ path: process.argv[2] + '/cs-sticky.png' });
  await p.locator('.board-scroll').evaluate(el => { el.scrollTop = 0; });
  await p.waitForTimeout(300);

  console.log('\nTeam size');
  const rd = async () => (await p.locator('tr.roundrow').allInnerTexts()).slice(0,3).map(t=>t.trim());
  await p.click('button:text-is("Redraft")'); await p.waitForTimeout(500);
  const r12 = await p.locator('#board tbody tr:not(.roundrow)').nth(11).innerText();
  await p.click('[data-set="teams=10"]'); await p.waitForTimeout(600);
  const r10 = await p.locator('#board tbody tr:not(.roundrow)').nth(11).innerText();
  check('12th pick changes round when league size changes', r12 !== r10, 'compared row 12');
  check('round labels present', (await rd()).join(',').includes('ROUND'), (await rd()).join(','));
  await p.click('[data-set="teams=12"]'); await p.waitForTimeout(500);

  console.log('\nSort by any active source');
  const opts = await p.locator('#sortby option').allInnerTexts();
  console.log('    options:', opts.join(', '));
  check('sort list matches active sources', opts.includes('FantasyPros') && opts.includes('Sleeper') && !opts.includes('FFC'));
  const first = async () => (await p.locator('#board tbody tr:not(.roundrow) td:nth-child(2)').first().innerText()).split('\n')[0];
  const base = await first();
  await p.selectOption('#sortby', '__gap'); await p.waitForTimeout(600);
  check('sorting by Sleeper gap reorders', await first() !== base, `${base} -> ${await first()}`);
  await p.selectOption('#sortby', '__split'); await p.waitForTimeout(600);
  check('sorting by disagreement reorders', await first() !== base, `-> ${await first()}`);
  await p.selectOption('#sortby', ''); await p.waitForTimeout(600);
  check('back to consensus restores', await first() === base);

  console.log('\nSuperflex keeps the source choice');
  await p.click('button[data-set="league=2QB"]'); await p.waitForTimeout(600);
  check('still no FFC after switching to Superflex', !(await heads()).some(h => h.startsWith('FFC')), (await heads()).join('|'));
  await p.click('button[data-set="league=1QB"]'); await p.waitForTimeout(600);
  await p.click('input[data-src="ffc"]'); await p.waitForTimeout(600);
  check('enabling FFC adds the column', (await heads()).includes('FFC'));
  await p.click('button[data-set="league=2QB"]'); await p.waitForTimeout(600);
  check('FFC stays enabled in Superflex', (await heads()).some(h => h.startsWith('FFC')), (await heads()).join('|'));
  await p.screenshot({ path: process.argv[2] + '/cs-sf.png' });

  console.log('\nerrors:', errs.length ? errs.slice(0,3) : 'none');
  if (errs.length) fails++;
  await b.close();
  console.log(`\n${fails===0?'\x1b[32mALL PASSED\x1b[0m':'\x1b[31m'+fails+' FAILED\x1b[0m'}\n`);
})();
