#!/usr/bin/env python3
"""Would gradient boosting beat the structured expected-points model?

    node server/scripts/experiments/export-learning-table.js /tmp/train.csv
    python3 server/scripts/experiments/gbm-headtohead.py [/tmp/train.csv]

Trains a gradient-boosted regressor on seasons strictly before each test season and
scores it against the structured model on identical rows, with identical information.

Scored on VALUE OVER REPLACEMENT, not on a pooled raw-points ranking. That distinction is
not cosmetic and it is the whole reason this script exists in the form it does: at four-
point passing touchdowns quarterbacks out-score everyone, so a pooled raw ranking mostly
measures whether a predictor reproduces that offset. Measured that way the GBM looks far
stronger than it is. See CLAUDE.md on Simpson's paradox.

Needs scikit-learn, pandas and scipy, which the app deliberately does not depend on.
"""
import sys
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.inspection import permutation_importance
from scipy.stats import spearmanr

PATH = sys.argv[1] if len(sys.argv) > 1 else '/tmp/train.csv'
TEST_SEASONS = [2023, 2024, 2025]
# A 12-team 1QB league's starters, matching combine.replacementLevels.
SLOTS = {'QB': 12, 'RB': 30, 'WR': 36, 'TE': 12}

df = pd.read_csv(PATH)
FEATS = [c for c in df.columns if c.startswith(('p1_', 'p2_'))] + ['age', 'depth_order']
for p in SLOTS:
    df['is_' + p] = (df.position == p).astype(int)
    FEATS.append('is_' + p)


def vor(frame, col):
    """Points above the last startable player at the position, on this series' own scale,
    so a predictor that runs high at one position is neither rewarded nor punished."""
    out = pd.Series(index=frame.index, dtype=float)
    for pos, k in SLOTS.items():
        s = frame[frame.position == pos][col].sort_values(ascending=False)
        repl = s.iloc[k - 1] if len(s) >= k else (s.iloc[-1] if len(s) else 0)
        out.loc[s.index] = s - repl
    return out


rows, importances, per_pos = [], [], []
for test in TEST_SEASONS:
    train = df[df.season < test]
    # Only rows the structured model could project, so both are scored on one population.
    held = df[(df.season == test) & df.model_ppg.notna()].copy()
    if len(held) < 50:
        continue

    gbm = HistGradientBoostingRegressor(
        max_iter=400, learning_rate=0.05, max_leaf_nodes=15,
        min_samples_leaf=25, l2_regularization=1.0, random_state=0)
    gbm.fit(train[FEATS].values, train.actual_ppg.values)
    held['gbm'] = gbm.predict(held[FEATS].values)

    actual = vor(held, 'actual_ppg')
    v_model, v_gbm = vor(held, 'model_ppg'), vor(held, 'gbm')
    rows.append({
        'season': test, 'n': len(held),
        'naive': spearmanr(vor(held, 'naive_ppg'), actual).statistic,
        'model': spearmanr(v_model, actual).statistic,
        'gbm': spearmanr(v_gbm, actual).statistic,
        # Blended on matching scales — ranking each on VOR first. Blending a raw
        # projection against a VOR one compares two different quantities and reports
        # nonsense.
        'blend': spearmanr(v_model.rank() + v_gbm.rank(), actual).statistic,
    })
    per_pos.append({'season': test, **{
        pos: f"{spearmanr(s.model_ppg, s.actual_ppg).statistic:.3f}/"
             f"{spearmanr(s.gbm, s.actual_ppg).statistic:.3f}"
        for pos in SLOTS
        for s in [held[held.position == pos]] if len(s) >= 15}})

    pi = permutation_importance(gbm, held[FEATS].values, held.actual_ppg.values,
                                n_repeats=8, random_state=0, scoring='r2')
    importances.append(pd.Series(pi.importances_mean, index=FEATS))

out = pd.DataFrame(rows).set_index('season')
print(f"rows {len(df)}, features {len(FEATS)}\n")
print("Spearman on next-season points per game, pooled on VALUE OVER REPLACEMENT\n")
print(out.round(4).to_string())
print("\nmean over " + str(len(out)) + " seasons:")
print(out.drop(columns='n').mean().round(4).to_string())

print("\nWithin position, model/gbm — where the pooled number comes from:\n")
print(pd.DataFrame(per_pos).set_index('season').to_string())

print("\nWhat the GBM leans on (permutation importance, mean over seasons).")
print("Everything above the fold is already an input to the structured model:\n")
print(pd.concat(importances, axis=1).mean(axis=1)
      .sort_values(ascending=False).head(10).round(4).to_string())
