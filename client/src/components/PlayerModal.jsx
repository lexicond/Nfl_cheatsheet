import React, { useState, useEffect, useRef } from 'react';

const POS_COLORS = {
  QB: 'text-amber-400',
  RB: 'text-green-400',
  WR: 'text-blue-400',
  TE: 'text-orange-400',
};

function NoteField({ label, value, onChange, onBlur }) {
  return (
    <div>
      <label className="block text-xs font-medium text-[#8b90a8] mb-1">{label}</label>
      <textarea
        value={value || ''}
        onChange={e => onChange(e.target.value)}
        onBlur={onBlur}
        rows={3}
        className="input w-full text-sm resize-none"
        placeholder="..."
      />
    </div>
  );
}

function AdpRow({ label, adp, posRank, position }) {
  return (
    <tr className="border-b border-[#1e2132]">
      <td className="py-1.5 pr-4 text-xs text-[#8b90a8]">{label}</td>
      <td className="py-1.5 pr-4 text-xs font-mono text-[#e8eaf0]">
        {adp != null ? adp.toFixed(1) : '–'}
      </td>
      <td className="py-1.5 text-xs font-mono text-[#8b90a8]">
        {posRank != null ? `${position}${posRank}` : '–'}
      </td>
    </tr>
  );
}

// Every ADP/value source the modal can show, with the field it reads. Rows for
// sources that have no number for this player are dropped rather than shown as "–",
// so the panel reflects what was actually fetched.
// The dynasty columns are aliased by the server: under 2QB, adp_fp_dyn and adp_sl_dyn
// carry the *superflex* numbers under their base names, because the board only ever
// shows one league type at a time. A fixed label would therefore be wrong in one of the
// two, so the dynasty rows are named from the league type actually on screen.
function sourceRows(leagueType) {
  const dyn = leagueType === '2QB' ? 'dynasty superflex' : 'dynasty 1QB';
  return [
    { label: 'Underdog (best ball)', field: 'adp_underdog', posRank: 'pos_rank_underdog' },
    { label: 'FantasyPros (best ball)', field: 'adp_fantasypros', posRank: 'pos_rank_fantasypros' },
    { label: 'FantasyPros (½PPR)', field: 'adp_fp_rd' },
    { label: 'FantasyPros (superflex)', field: 'adp_fp_sf' },
    { label: `FantasyPros (${dyn})`, field: 'adp_fp_dyn' },
    { label: `Sleeper (${dyn})`, field: 'adp_sl_dyn' },
    { label: 'FFC (½PPR)', field: 'adp_ffc' },
    { label: 'FFC (2QB)', field: 'adp_ffc_sf' },
    { label: 'Sleeper (½PPR)', field: 'adp_sl_rd' },
    { label: 'Sleeper (2QB)', field: 'adp_sl_sf' },
    { label: 'ESPN (PPR)', field: 'adp_espn' },
    { label: 'Yahoo (½PPR)', field: 'adp_yahoo' },
  ];
}

/**
 * The expected-points breakdown: opportunity, what the market expects of his offence,
 * and the spread of the simulated season. Deliberately plain-language — the point is
 * that a number can be argued with, not that it looks authoritative.
 */
function ModelBreakdown({ player }) {
  if (player.xfp_points == null) return null;

  let c = null;
  try {
    c = player.xfp_components ? JSON.parse(player.xfp_components) : null;
  } catch {
    c = null;   // a malformed breakdown must not blank the whole panel
  }

  const Row = ({ label, value, note }) => (
    <div className="flex items-baseline justify-between gap-3 py-1 border-b border-[#1e2132] last:border-0">
      <span className="text-xs text-[#8b90a8]">{label}</span>
      <span className="text-xs font-mono text-[#e8eaf0] text-right">
        {value}
        {note && <span className="text-[#555875] font-normal"> {note}</span>}
      </span>
    </div>
  );

  const opportunity = c && !c.basis ? [
    c.targets_pg ? `${c.targets_pg.toFixed(1)} targets` : null,
    c.carries_pg ? `${c.carries_pg.toFixed(1)} carries` : null,
    c.attempts_pg ? `${c.attempts_pg.toFixed(1)} pass attempts` : null,
  ].filter(Boolean).join(' · ') : null;

  return (
    <div>
      <h3 className="text-xs font-semibold text-[#555875] uppercase tracking-wider mb-2">
        Expected Points — how the model got there
      </h3>
      <div className="rounded border border-[#2e3148] bg-[#141721] px-3 py-2">
        <Row
          label="Projection"
          value={`${player.xfp_points.toFixed(0)} pts`}
          note={player.xfp_games != null ? `over ${player.xfp_games.toFixed(1)} games` : null}
        />
        {player.xfp_vor != null && (
          <Row label="Value over replacement" value={`${player.xfp_vor.toFixed(0)} pts`}
               note="vs the last startable player at his position" />
        )}
        {(player.xfp_floor != null || player.xfp_ceiling != null) && (
          <Row
            label="Simulated season"
            value={`${player.xfp_floor != null ? player.xfp_floor.toFixed(0) : '?'} – ${player.xfp_ceiling != null ? player.xfp_ceiling.toFixed(0) : '?'}`}
            note="floor to ceiling, 15th–85th percentile"
          />
        )}
        {player.xfp_best_ball != null && (
          <Row label="Best-ball score" value={`${player.xfp_best_ball.toFixed(0)} pts`}
               note="counting only his best weeks" />
        )}
        {opportunity && <Row label="Opportunity per game" value={opportunity} />}
        {c?.basis && <Row label="Basis" value={c.basis} note={c.draft_ovr ? `pick ${c.draft_ovr}` : null} />}
        {c?.env_total != null && (
          <Row
            label="Team environment"
            value={`${c.env_team} · ${c.env_total} pts/game`}
            note={c.env_source === 'market' ? 'betting market' : `${c.env_source} estimate`}
          />
        )}
        {c?.level_season && (
          <Row label="Role taken from" value={String(c.level_season)}
               note="his most recent season" />
        )}
        {c?.seasons_used && c.seasons_used.length > 1 && (
          <Row label="Efficiency weighed over" value={c.seasons_used.join(', ')}
               note={c.opportunities ? `${c.opportunities} opportunities` : null} />
        )}
      </div>
      <div className="text-xs text-[#555875] mt-1.5 italic">
        {player.xfp_confidence === 'low'
          ? 'Low confidence: little or no recent NFL usage behind this, so it leans on positional baselines and draft capital.'
          : 'This is the board\u2019s own model, not a published projection. It is never averaged into the consensus.'}
      </div>
    </div>
  );
}

export default function PlayerModal({ player, onClose, onUpdate, sourceStatus = {}, format = 'BB', leagueType = '1QB' }) {
  const [draft, setDraft] = useState(null);
  const [saved, setSaved] = useState(false);
  const panelRef = useRef(null);

  useEffect(() => {
    if (player) {
      setDraft({ ...player });
      setSaved(false);
    }
  }, [player]);

  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  if (!player || !draft) return null;

  const save = (changes = {}) => {
    const merged = { ...draft, ...changes };
    setDraft(merged);
    onUpdate(player.id, merged);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const setField = (key, val) => setDraft(d => ({ ...d, [key]: val }));

  const toggleBool = (key) => {
    const newVal = !draft[key];
    setDraft(d => ({ ...d, [key]: newVal }));
    onUpdate(player.id, { [key]: newVal });
  };

  const udNote = sourceStatus?.underdog?.notes;

  return (
    <>
      <div className="fixed inset-0 bg-black/50 z-40 backdrop-blur-sm" onClick={onClose} />

      <div
        ref={panelRef}
        className="fixed right-0 top-0 h-full w-full max-w-md bg-[#1a1d27] border-l border-[#2e3148] z-50 overflow-y-auto flex flex-col shadow-2xl"
      >
        {/* Header */}
        <div className="flex items-start justify-between p-5 border-b border-[#2e3148] sticky top-0 bg-[#1a1d27] z-10">
          <div>
            <div className="flex items-center gap-2 mb-0.5">
              <span className={`pos-badge pos-${player.position}`}>{player.position}</span>
              <h2 className="text-lg font-bold text-[#e8eaf0]">{player.name}</h2>
            </div>
            <div className="text-sm text-[#555875]">
              {player.nfl_team && <span>{player.nfl_team}</span>}
              {player.bye_week && <span> · Bye {player.bye_week}</span>}
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-[#555875] hover:text-[#e8eaf0] text-xl leading-none p-1 mt-0.5"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 p-5 space-y-5">
          {/* ADP Comparison */}
          <div>
            <h3 className="text-xs font-semibold text-[#555875] uppercase tracking-wider mb-2">ADP / Value Comparison</h3>
            <table className="w-full">
              <thead>
                <tr>
                  <th className="text-left text-xs text-[#555875] py-1 pr-4">Source</th>
                  <th className="text-left text-xs text-[#555875] py-1 pr-4">ADP / Value</th>
                  <th className="text-left text-xs text-[#555875] py-1">Pos Rank</th>
                </tr>
              </thead>
              <tbody>
                {sourceRows(leagueType).filter(row => player[row.field] != null).map(row => (
                  <AdpRow
                    key={row.field}
                    label={row.field === 'adp_underdog' && udNote && !udNote.startsWith('Underdog')
                      ? `Underdog — ${udNote}`
                      : row.label}
                    adp={player[row.field]}
                    posRank={row.posRank ? player[row.posRank] : null}
                    position={player.position}
                  />
                ))}
                {(player.ktc_value != null || player.fc_value != null) && (
                  <tr className="border-b border-[#1e2132]">
                    <td className="py-1.5 pr-4 text-xs text-[#8b90a8]">Dynasty (KTC / FC)</td>
                    <td className="py-1.5 pr-4 text-xs font-mono text-[#e8eaf0]">
                      {player.ktc_value != null ? player.ktc_value.toLocaleString() : '–'} / {player.fc_value != null ? player.fc_value.toFixed(0) : '–'}
                    </td>
                    <td className="py-1.5 text-xs text-[#555875]">trade values</td>
                  </tr>
                )}
                <tr className="border-b border-[#1e2132]">
                  <td className="py-1.5 pr-4 text-xs font-semibold text-[#e8eaf0]">
                    {format === 'DYN' ? 'Dynasty rank' : 'Consensus'}
                  </td>
                  <td className="py-1.5 pr-4 text-xs font-mono font-bold text-[#e8eaf0]">
                    {player.adp_consensus != null ? player.adp_consensus.toFixed(1) : '–'}
                  </td>
                  <td className="py-1.5 text-xs text-[#555875]">
                    {player.pos_rank_consensus != null ? `${player.position}${player.pos_rank_consensus} · ` : ''}
                    {player.adp_source_count > 0 ? `${player.adp_source_count} source${player.adp_source_count !== 1 ? 's' : ''}` : ''}
                  </td>
                </tr>
                {player.projected_pts != null && (
                  <tr className="border-b border-[#1e2132]">
                    <td className="py-1.5 pr-4 text-xs text-[#8b90a8]">Proj Pts (0.5 PPR)</td>
                    <td className={`py-1.5 pr-4 text-xs font-mono font-bold ${POS_COLORS[player.position] || 'text-[#e8eaf0]'}`}>
                      {player.projected_pts.toFixed(1)}
                    </td>
                    <td className="py-1.5 text-xs text-[#555875]">
                      {player.proj_pos_rank != null ? `${player.position}${player.proj_pos_rank}` : ''}
                    </td>
                  </tr>
                )}
                {player.xfp_points != null && (
                  <tr className="border-b border-[#1e2132]">
                    <td className="py-1.5 pr-4 text-xs text-[#8b90a8]">Expected Points (model)</td>
                    <td className={`py-1.5 pr-4 text-xs font-mono font-bold ${POS_COLORS[player.position] || 'text-[#e8eaf0]'}`}>
                      {player.xfp_points.toFixed(0)}
                      {player.xfp_vor != null && (
                        <span className="text-[#8b90a8] font-normal"> · {player.xfp_vor.toFixed(0)} VOR</span>
                      )}
                    </td>
                    <td className="py-1.5 text-xs text-[#555875]">
                      {player.xfp_pos_rank != null ? `${player.position}${player.xfp_pos_rank}` : ''}
                      {player.xfp_confidence === 'low' ? ' · low confidence' : ''}
                    </td>
                  </tr>
                )}
                {player.adp_trend != null && Math.abs(player.adp_trend) >= 1.5 && (
                  <tr>
                    <td className="py-1.5 pr-4 text-xs text-[#8b90a8]">ADP Trend</td>
                    <td className={`py-1.5 pr-4 text-xs font-mono font-bold ${player.adp_trend > 0 ? 'text-green-400' : 'text-red-400'}`}>
                      {player.adp_trend > 0 ? `▲ Rising ${player.adp_trend.toFixed(1)}` : `▼ Falling ${Math.abs(player.adp_trend).toFixed(1)}`}
                    </td>
                    <td className="py-1.5 text-xs text-[#555875]">picks</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* How the model got there. This column is the board's own work rather than
              somebody else's published number, so there is no second source to check it
              against — the parts have to be visible instead. */}
          <ModelBreakdown player={player} />

          {/* Quick toggles */}
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => toggleBool('starred')}
              className={`btn text-sm px-3 py-1.5 ${draft.starred ? 'bg-amber-500/20 text-amber-400 border border-amber-500/40' : 'btn-ghost'}`}
            >
              {draft.starred ? '⭐ Starred' : '☆ Star'}
            </button>
            <button
              onClick={() => toggleBool('flagged')}
              className={`btn text-sm px-3 py-1.5 ${draft.flagged ? 'bg-red-500/20 text-red-400 border border-red-500/40' : 'btn-ghost'}`}
            >
              {draft.flagged ? '🚩 Flagged' : '⚑ Flag'}
            </button>
            <button
              onClick={() => toggleBool('drafted')}
              className={`btn text-sm px-3 py-1.5 ${draft.drafted ? 'bg-green-500/20 text-green-400 border border-green-500/40' : 'btn-ghost'}`}
            >
              {draft.drafted ? '✓ Drafted' : '○ Not Drafted'}
            </button>
          </div>

          {/* Tier selector */}
          <div>
            <h3 className="text-xs font-semibold text-[#555875] uppercase tracking-wider mb-2">Tier</h3>
            <div className="flex gap-1.5 items-center">
              {[1, 2, 3, 4, 5].map(t => (
                <button
                  key={t}
                  onClick={() => {
                    const newTier = draft.tier === t ? null : t;
                    setDraft(d => ({ ...d, tier: newTier }));
                    onUpdate(player.id, { tier: newTier });
                  }}
                  className={`tier-badge w-8 h-8 ${draft.tier === t ? `tier-${t}` : 'border-[#2e3148] text-[#555875] hover:text-[#8b90a8]'}`}
                >
                  {t}
                </button>
              ))}
              {draft.tier && (
                <button
                  onClick={() => { setDraft(d => ({ ...d, tier: null })); onUpdate(player.id, { tier: null }); }}
                  className="text-xs text-[#555875] hover:text-red-400 ml-1"
                >
                  clear
                </button>
              )}
            </div>
            {!draft.tier && player.tier_auto && (
              <div className="text-xs text-[#555875] mt-1.5 italic">
                Auto-tier: T{player.tier_auto} (ADP-based · click above to override)
              </div>
            )}
          </div>

          {/* Notes */}
          <div className="space-y-4">
            <NoteField
              label="📈 Upside"
              value={draft.note_upside}
              onChange={v => setField('note_upside', v)}
              onBlur={() => save()}
            />
            <NoteField
              label="📉 Downside / Risk"
              value={draft.note_downside}
              onChange={v => setField('note_downside', v)}
              onBlur={() => save()}
            />
            <NoteField
              label="🗞️ Analyst Notes"
              value={draft.note_sources}
              onChange={v => setField('note_sources', v)}
              onBlur={() => save()}
            />
            <NoteField
              label="💭 Personal Notes"
              value={draft.note_personal}
              onChange={v => setField('note_personal', v)}
              onBlur={() => save()}
            />
          </div>
        </div>

        {/* Footer */}
        <div className="p-5 border-t border-[#2e3148] flex items-center justify-between sticky bottom-0 bg-[#1a1d27]">
          <span className={`text-xs transition-opacity ${saved ? 'text-green-400 opacity-100' : 'opacity-0'}`}>
            Saved ✓
          </span>
          <button onClick={onClose} className="btn-ghost text-sm">Close</button>
        </div>
      </div>
    </>
  );
}
