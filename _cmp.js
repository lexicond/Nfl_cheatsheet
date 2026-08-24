const { get, JSON_HEADERS } = require('./server/utils/http');
const { db } = require('./server/db');
const SEASON = new Date().getFullYear();
const URL = `https://api.sleeper.app/projections/nfl/${SEASON}?season_type=regular&position[]=QB&position[]=RB&position[]=WR&position[]=TE&order_by=pts_half_ppr`;

(async () => {
  const res = await get(URL, { headers: JSON_HEADERS, timeout: 45000, retries: 1 });
  const bySid = new Map();
  for (const row of res.data || []) {
    if (row.player_id != null) bySid.set(String(row.player_id), row.stats || {});
  }
  const sample = [...bySid.values()][0];
  console.log('Sleeper stat fields available:', Object.keys(sample).filter(k => !/^adp|^pts_|^rank/.test(k)).join(', '));
  console.log('');

  const board = db.prepare(`
    SELECT name, position, sleeper_player_id sid, xfp_games g, xfp_points m, projected_pts s, xfp_components c
    FROM players WHERE xfp_points IS NOT NULL AND sleeper_player_id IS NOT NULL
  `).all();

  // component-by-component, per position
  const METRICS = [
    ['targets',    c => c.targets_pg,   s => s.rec_tgt],
    ['receptions', c => c.receptions_pg, s => s.rec],
    ['rec yards',  c => c.rec_yards_pg, s => s.rec_yd],
    ['rec TDs',    c => c.rec_tds_pg,   s => s.rec_td],
    ['carries',    c => c.carries_pg,   s => s.rush_att],
    ['rush yards', c => c.rush_yards_pg, s => s.rush_yd],
    ['rush TDs',   c => c.rush_tds_pg,  s => s.rush_td],
    ['pass att',   c => c.attempts_pg,  s => s.pass_att],
    ['pass yards', c => c.pass_yards_pg, s => s.pass_yd],
    ['pass TDs',   c => c.pass_tds_pg,  s => s.pass_td],
    ['games',      (c, g) => g / 17,    s => (s.gp != null ? s.gp / 17 : null)],
  ];

  for (const pos of ['QB', 'RB', 'WR', 'TE']) {
    const rows = board.filter(r => r.position === pos);
    console.log(`--- ${pos} (n=${rows.length} with a projection) ---`);
    for (const [label, fromModel, fromSleeper] of METRICS) {
      let mm = 0, ss = 0, n = 0;
      for (const r of rows) {
        const st = bySid.get(String(r.sid)); if (!st) continue;
        const c = JSON.parse(r.c || '{}');
        const g = r.g || 17;
        const mv = (fromModel(c, g) || 0) * (label === 'games' ? 17 : g);
        const sv = Number(fromSleeper(st));
        if (!Number.isFinite(sv) || sv <= 0) continue;
        if (mv <= 0 && sv <= 0) continue;
        mm += mv; ss += sv; n++;
      }
      if (n < 5) continue;
      const ratio = ss > 0 ? mm / ss : null;
      const flag = ratio != null && (ratio > 1.12 || ratio < 0.88) ? '   <<<' : '';
      console.log(`   ${label.padEnd(11)} n=${String(n).padStart(3)}  model ${(mm/n).toFixed(1).padStart(7)}  sleeper ${(ss/n).toFixed(1).padStart(7)}  ratio ${ratio.toFixed(3)}${flag}`);
    }
    console.log('');
  }
})().catch(e => console.error('ERR', e.message));
