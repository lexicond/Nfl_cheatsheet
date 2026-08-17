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
  for (const theme of ['light','dark']) {
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, colorScheme: theme });
    const p = await ctx.newPage();
    const errs=[]; p.on('pageerror',e=>errs.push(e.message));
    await p.goto(SHEET_URL);
    await p.waitForTimeout(700);
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    const paneScrolls = await p.evaluate(() => {
      const el = document.querySelector('.board-scroll');
      return el ? { h: Math.round(el.clientHeight), scrollable: el.scrollHeight > el.clientHeight } : null;
    });
    console.log(`${theme} phone: body h-overflow=${overflow} | board pane ${JSON.stringify(paneScrolls)} | errors=${errs.length?errs[0]:'none'}`);
    await p.screenshot({ path: `${process.argv[2]}/final-phone-${theme}.png` });
    await ctx.close();
  }
  // desktop dark
  const ctx = await b.newContext({ viewport: { width: 1500, height: 950 }, colorScheme: 'dark' });
  const p = await ctx.newPage();
  await p.goto(SHEET_URL);
  await p.waitForTimeout(600);
  await p.click('button:text-is("Redraft")'); await p.waitForTimeout(500);
  await p.locator('.board-scroll').evaluate(el => { el.scrollTop = 1500; });
  await p.waitForTimeout(400);
  await p.screenshot({ path: process.argv[2] + '/final-desktop-dark.png' });
  await b.close();
})();
