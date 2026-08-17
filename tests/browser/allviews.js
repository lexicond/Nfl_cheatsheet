const { chromium } = require('playwright');
const path = require('path');

// PLAYWRIGHT_CHROMIUM points at a prebuilt browser where one exists; otherwise
// Playwright's own download is used. APP_URL overrides the server address.
const LAUNCH = process.env.PLAYWRIGHT_CHROMIUM
  ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM }
  : {};
const APP_URL = process.env.APP_URL || 'http://localhost:3000';
const SHEET_URL = 'file://' + path.resolve(__dirname, '../../cheatsheets/draft-room-2026.html');

(async () => {
  const b = await chromium.launch(LAUNCH);
  const p = await (await b.newContext({ viewport: { width: 1600, height: 950 } })).newPage();
  const errs = [];
  p.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  p.on('console', m => { if (m.type()==='error' && !m.text().includes('ERR_CONNECTION')) errs.push(m.text()); });
  await p.goto(APP_URL, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1200);
  for (const fmt of ['Best Ball','Redraft','Dynasty']) {
    for (const lt of ['1QB','SF/2QB']) {
      await p.click(`button:text-is("${fmt}")`); await p.waitForTimeout(400);
      await p.click(`button:text-is("${lt}")`); await p.waitForTimeout(700);
      for (const t of ['8','14','12']) { await p.click(`button[title*="${t}-team"]`); await p.waitForTimeout(400); }
      const rows = await p.locator('tbody tr').count();
      const hdr = (await p.locator('thead th').allInnerTexts()).map(x=>x.trim()).filter(Boolean);
      console.log(`${fmt}/${lt}: ${rows} rows, ${hdr.length} cols`);
    }
  }
  console.log('\nerrors across all 6 views x 3 league sizes:', errs.length ? errs.slice(0,3) : 'none');
  await b.close();
  process.exit(errs.length ? 1 : 0);
})();
