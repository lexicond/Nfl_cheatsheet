# Experiments

Nothing in here runs as part of a refresh, and nothing on the board depends on it. These
are the scripts behind numbers quoted in `CLAUDE.md` and `HANDOVER.md`, kept so the claims
can be rechecked rather than believed.

`gbm-headtohead.py` needs Python with `scikit-learn` and `pandas`, which the app itself
does not. It is deliberately not a dependency.

## Would gradient boosting be better than the structured model?

```
node server/scripts/experiments/export-learning-table.js /tmp/train.csv
python3 server/scripts/experiments/gbm-headtohead.py     # reads /tmp/train.csv
```

The exporter dumps one row per player-season with exactly the information the structured
model has — the two prior seasons of usage and efficiency, age, position and that season's
week-one depth chart — plus the structured model's own projection for the same row, so the
two are compared on identical players. The Python script trains a gradient-boosted
regressor on seasons strictly before each test season and scores both.

What it found, over 2023-25, pooled on value over replacement:

| | 2023 | 2024 | 2025 | mean |
|---|---|---|---|---|
| repeat last season | 0.651 | 0.678 | 0.677 | 0.669 |
| this model | 0.680 | 0.683 | 0.736 | 0.700 |
| gradient boosting | 0.713 | 0.735 | 0.700 | 0.716 |
| the two, blended 50/50 | **0.735** | **0.741** | **0.739** | **0.738** |

Three things in that table matter more than the ranking.

**The GBM's edge is fitted weights, not new information.** Permutation importance puts
last season's points per game at 0.33, the depth chart at 0.12, the season before at 0.065
and age at 0.023, with nothing else above 0.011. Those are precisely the structured model's
inputs. It is not finding signal the model lacks; it is weighing the same signal better
than hand-set shrinkage constants do.

**It is not consistent.** It wins 2023 and 2024 comfortably and loses 2025, which is the
season with the most training data. On a pooled raw-points ranking rather than VOR it looks
far stronger (0.746 against 0.710) — but that comparison is the Simpson's-paradox trap
`CLAUDE.md` warns about, and most of the apparent margin is the positional offset rather
than any ordering.

**The blend beats both, in every season.** That is the actionable result: the two disagree
in uncorrelated ways, so the question is not which to keep.

What a GBM cannot do, and why it is not a drop-in replacement: it produces a point estimate
rather than a distribution, so there is no floor, ceiling or best-ball number; it cannot
satisfy the conservation identities, so its team totals are whatever they come out as; it
has nothing to say about a rookie, whose features are all missing; and it cannot explain a
number, which is most of what this board is for.

The sensible use is therefore not to replace the model but to replace a STAGE of it.
Module A — next season's targets, carries and attempts per game — is a clean supervised
problem, it is where the hand-set shrinkage constants live, and a learned version of it
would leave the identities, the simulation, the rookie path and the explanations intact.
