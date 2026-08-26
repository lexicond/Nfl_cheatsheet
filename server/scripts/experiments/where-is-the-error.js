/**
 * Ceiling analysis: where is the model's error actually?
 *
 * A player's projection is (team volume) x (his share of it) x (efficiency). Handing the
 * model perfect knowledge of ONE of those and leaving the rest as it is gives an upper
 * bound on what improving that stage could ever be worth. Comparing the bounds says which
 * stage is worth building for.
 */
const P = '/home/user/Nfl_cheatsheet/server';
const nflverse = require(P + '/model/nflverse');
const { runModel } = require(P + '/model');
const { aggregateSeason } = require(P + '/model/usage');
const { correlation } = require(P + '/model/stability');

const spearman = (pairs) => {
  if (pairs.length < 10) return null;
  const rank = i => { const o = pairs.map((p, k) => [p[i], k]).sort((a, b) => a[0] - b[0]);
    const r = new Array(pairs.length); o.forEach(([, k], j) => { r[k] = j + 1; }); return r; };
  const a = rank(0), b = rank(1);
  return correlation(a.map((v, i) => [v, b[i]]));
};
const sd = v => { const m = v.reduce((a, c) => a + c, 0) / v.length;
  return Math.sqrt(v.reduce((a, c) => a + (c - m) ** 2, 0) / v.length); };

(async () => {
  for (const season of [2023, 2024, 2025]) {
    const actual = aggregateSeason((await nflverse.loadSeasonStats(season)).rows, season);
    const prior = aggregateSeason((await nflverse.loadSeasonStats(season - 1)).rows, season - 1);
    const before = aggregateSeason((await nflverse.loadSeasonStats(season - 2)).rows, season - 2);
    const depth = await nflverse.loadDepthChart(season);
    const { projections } = await runModel({
      targetSeason: season, environmentMaxWeek: 6, useHistoryTeam: true,
      useOdds: false, iterations: 60, depthChart: depth,
    });

    // What each team ACTUALLY did that season.
    const actTeam = {};
    for (const p of actual.values()) {
      const t = nflverse.normaliseTeam(p.team); if (!t) continue;
      actTeam[t] = actTeam[t] || { tgt: 0, car: 0, att: 0 };
      actTeam[t].tgt += p.targets; actTeam[t].car += p.carries; actTeam[t].att += p.attempts;
    }
    // What the model thought each team would do.
    const modTeam = {};
    for (const p of projections) {
      const t = p.team; if (!t) continue;
      const g = p.games || 0;
      modTeam[t] = modTeam[t] || { tgt: 0, car: 0, att: 0 };
      modTeam[t].tgt += (p.components.targets_pg || 0) * g;
      modTeam[t].car += (p.components.carries_pg || 0) * g;
      modTeam[t].att += (p.components.attempts_pg || 0) * g;
    }

    // Pool: same rule as the validator.
    const rows = [];
    for (const p of projections) {
      if (p.components?.basis) continue;
      const a = actual.get(p.gsis_id);
      if (!a || a.games < 1) continue;
      const pr = prior.get(p.gsis_id), bf = before.get(p.gsis_id);
      if (!((pr && pr.games >= 6) || (bf && bf.games >= 6))) continue;
      const t = p.team;
      if (!actTeam[t] || !modTeam[t]) continue;
      const c = p.components;

      // Oracle A — perfect TEAM volume, model's own share and efficiency. This is exactly
      // what the conservation step does, so substituting the true budget is faithful.
      const fT = modTeam[t].tgt > 0 ? actTeam[t].tgt / modTeam[t].tgt : 1;
      const fC = modTeam[t].car > 0 ? actTeam[t].car / modTeam[t].car : 1;
      const fA = modTeam[t].att > 0 ? actTeam[t].att / modTeam[t].att : 1;
      const oracleTeam = (c.receiving || 0) * fT + (c.rushing || 0) * fC + (c.passing || 0) * fA;

      // Oracle B — perfect SHARE of his team, model's own team volume and efficiency.
      const mShareT = modTeam[t].tgt > 0 ? ((c.targets_pg || 0) * (p.games || 0)) / modTeam[t].tgt : 0;
      const mShareC = modTeam[t].car > 0 ? ((c.carries_pg || 0) * (p.games || 0)) / modTeam[t].car : 0;
      const mShareA = modTeam[t].att > 0 ? ((c.attempts_pg || 0) * (p.games || 0)) / modTeam[t].att : 0;
      const aShareT = actTeam[t].tgt > 0 ? a.targets / actTeam[t].tgt : 0;
      const aShareC = actTeam[t].car > 0 ? a.carries / actTeam[t].car : 0;
      const aShareA = actTeam[t].att > 0 ? a.attempts / actTeam[t].att : 0;
      const sT = mShareT > 0 ? aShareT / mShareT : 1;
      const sC = mShareC > 0 ? aShareC / mShareC : 1;
      const sA = mShareA > 0 ? aShareA / mShareA : 1;
      const oracleShare = (c.receiving || 0) * sT + (c.rushing || 0) * sC + (c.passing || 0) * sA;

      rows.push({
        pos: p.position, model: p.ppg, actual: a.ppg,
        naive: pr ? pr.ppg : 0, oracleTeam, oracleShare,
        // log-space error decomposition on OPPORTUNITY, the part the model claims to know
        logTeam: (modTeam[t].tgt + modTeam[t].car) > 0 && (actTeam[t].tgt + actTeam[t].car) > 0
          ? Math.log((actTeam[t].tgt + actTeam[t].car) / (modTeam[t].tgt + modTeam[t].car)) : null,
        logShare: (mShareT + mShareC) > 0 && (aShareT + aShareC) > 0
          ? Math.log((aShareT + aShareC) / (mShareT + mShareC)) : null,
      });
    }

    const S = (k) => spearman(rows.map(r => [r[k], r.actual])).toFixed(4);
    console.log(`\n=== ${season}  n=${rows.length}`);
    console.log(`  naive                       ${spearman(rows.map(r => [r.naive, r.actual])).toFixed(4)}`);
    console.log(`  model                       ${S('model')}`);
    console.log(`  + perfect TEAM volume       ${S('oracleTeam')}`);
    console.log(`  + perfect WITHIN-TEAM share ${S('oracleShare')}`);

    const lt = rows.map(r => r.logTeam).filter(v => v != null && Number.isFinite(v));
    const ls = rows.map(r => r.logShare).filter(v => v != null && Number.isFinite(v));
    console.log(`  log-error sd: team volume ${sd(lt).toFixed(3)}   within-team share ${sd(ls).toFixed(3)}`);
    for (const pos of ['RB', 'WR', 'TE']) {
      const sub = rows.filter(r => r.pos === pos);
      if (sub.length < 15) continue;
      console.log(`    ${pos}: model ${spearman(sub.map(r => [r.model, r.actual])).toFixed(3)}` +
        `  +team ${spearman(sub.map(r => [r.oracleTeam, r.actual])).toFixed(3)}` +
        `  +share ${spearman(sub.map(r => [r.oracleShare, r.actual])).toFixed(3)}`);
    }
  }
})();
