/**
 * Does a head-coaching change move a team's pass/run mix, and is it predictable?
 *
 * Coach comes from the schedules file the model already downloads; the pass/run split
 * from the same season stats it already loads. Nothing new is fetched.
 */
const P = '/home/user/Nfl_cheatsheet/server';
const nflverse = require(P + '/model/nflverse');
const { aggregateSeason } = require(P + '/model/usage');
const { correlation } = require(P + '/model/stability');
const fs = require('fs'); const path = require('path');

const med = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const sd = a => { const m = mean(a); return Math.sqrt(mean(a.map(v => (v - m) ** 2))); };

(async () => {
  const SEASONS = [2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];

  // Head coach per team-season, from the schedules file.
  const sched = nflverse.parseCsv(fs.readFileSync(path.join(nflverse.CACHE_DIR, 'schedules.csv'), 'utf8')).rows;
  const coach = {};              // "team|season" -> coach
  for (const r of sched) {
    const s = Number(r.season);
    if (!SEASONS.includes(s) || r.game_type !== 'REG') continue;
    for (const side of ['home', 'away']) {
      const t = nflverse.normaliseTeam(r[`${side}_team`]);
      const c = r[`${side}_coach`];
      if (t && c && c !== 'NA') coach[`${t}|${s}`] = c;
    }
  }

  // Team pass rate = attempts / (attempts + carries), from player stats.
  const rate = {};
  for (const season of SEASONS) {
    const agg = aggregateSeason((await nflverse.loadSeasonStats(season)).rows, season);
    const tot = {};
    for (const p of agg.values()) {
      const t = nflverse.normaliseTeam(p.team); if (!t) continue;
      tot[t] = tot[t] || { att: 0, car: 0 };
      tot[t].att += p.attempts; tot[t].car += p.carries;
    }
    for (const [t, v] of Object.entries(tot)) {
      if (v.att + v.car > 600) rate[`${t}|${season}`] = v.att / (v.att + v.car);
    }
  }

  const all = Object.values(rate);
  console.log(`team-seasons: ${all.length}   league pass rate mean ${(mean(all) * 100).toFixed(1)}%  sd ${(sd(all) * 100).toFixed(1)}pp`);

  // Year-over-year change, split on whether the head coach changed.
  const same = [], changed = [], pairsSame = [], pairsChanged = [];
  const newCoachPrior = [];      // incoming coach's pass rate at his previous stop
  for (const season of SEASONS.slice(1)) {
    for (const key of Object.keys(rate)) {
      const [t, s] = key.split('|'); if (Number(s) !== season) continue;
      const prev = rate[`${t}|${season - 1}`]; if (prev == null) continue;
      const c0 = coach[`${t}|${season - 1}`], c1 = coach[`${t}|${season}`];
      if (!c0 || !c1) continue;
      const delta = rate[key] - prev;
      (c0 === c1 ? same : changed).push(delta);
      (c0 === c1 ? pairsSame : pairsChanged).push([prev, rate[key]]);

      if (c0 !== c1) {
        // What did the incoming coach's previous team throw, the last time he ran one?
        let his = null;
        for (let back = 1; back <= 6 && his == null; back++) {
          for (const k2 of Object.keys(coach)) {
            const [t2, s2] = k2.split('|');
            if (Number(s2) !== season - back || coach[k2] !== c1 || t2 === t) continue;
            if (rate[k2] != null) his = rate[k2];
          }
        }
        if (his != null) newCoachPrior.push({ team: t, season, prev, now: rate[key], his });
      }
    }
  }

  console.log(`\nYear-on-year change in team pass rate:`);
  console.log(`  same head coach   n=${String(same.length).padStart(3)}   median |change| ${(med(same.map(Math.abs)) * 100).toFixed(2)}pp   sd ${(sd(same) * 100).toFixed(2)}pp`);
  console.log(`  coach CHANGED     n=${String(changed.length).padStart(3)}   median |change| ${(med(changed.map(Math.abs)) * 100).toFixed(2)}pp   sd ${(sd(changed) * 100).toFixed(2)}pp`);
  console.log(`\n  persistence of pass rate (this year vs last):`);
  console.log(`    same coach    r=${correlation(pairsSame).toFixed(3)}`);
  console.log(`    coach changed r=${correlation(pairsChanged).toFixed(3)}`);

  console.log(`\nWhen a new coach arrives (n=${newCoachPrior.length}), what predicts the new pass rate?`);
  console.log(`  the team's own previous rate      r=${correlation(newCoachPrior.map(d => [d.prev, d.now])).toFixed(3)}`);
  console.log(`  the COACH's rate at his last stop r=${correlation(newCoachPrior.map(d => [d.his, d.now])).toFixed(3)}`);
  const blend = newCoachPrior.map(d => [(d.prev + d.his) / 2, d.now]);
  console.log(`  the two averaged                  r=${correlation(blend).toFixed(3)}`);
})();
