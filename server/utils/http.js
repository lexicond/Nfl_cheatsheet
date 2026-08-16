const axios = require('axios');

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7',
  'Accept-Language': 'en-US,en;q=0.9',
};

const JSON_HEADERS = {
  'User-Agent': BROWSER_HEADERS['User-Agent'],
  'Accept': 'application/json, text/plain, */*',
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * GET with bounded retries. Retries network errors and 5xx/429 only —
 * a 404 or 403 is a permanent answer and retrying just wastes the refresh budget.
 */
async function get(url, { headers = BROWSER_HEADERS, timeout = 25000, retries = 2, responseType } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await axios.get(url, { headers, timeout, responseType, validateStatus: s => s >= 200 && s < 300 });
    } catch (err) {
      lastErr = err;
      const status = err.response?.status;
      const retriable = status == null || status === 429 || status >= 500;
      if (!retriable || attempt === retries) break;
      await sleep(500 * Math.pow(2, attempt));
    }
  }
  throw lastErr;
}

/**
 * Pull a top-level JavaScript object literal out of an HTML page by variable name.
 * Brace-matches while tracking string state so quoted braces don't end the scan.
 */
function extractJsObject(html, varName) {
  if (typeof html !== 'string') return null;
  const at = html.indexOf(varName);
  if (at < 0) return null;
  const eq = html.indexOf('=', at);
  if (eq < 0) return null;
  const start = html.indexOf('{', eq);
  if (start < 0) return null;

  let depth = 0;
  let inStr = false;
  let quote = '';
  let esc = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === quote) inStr = false;
      continue;
    }
    if (c === '"' || c === "'") { inStr = true; quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

module.exports = { get, extractJsObject, BROWSER_HEADERS, JSON_HEADERS };
