import React, { useState, useRef } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

const SEASON_YEAR = new Date().getFullYear();

const TIER_BORDER = {
  1: 'border-l-2 border-l-amber-500',
  2: 'border-l-2 border-l-blue-500',
  3: 'border-l-2 border-l-green-500',
  4: 'border-l-2 border-l-purple-500',
  5: 'border-l-2 border-l-gray-500',
};

function AdpCell({ value }) {
  if (value == null) return <span className="text-[#555875]">–</span>;
  return <span>{value.toFixed(1)}</span>;
}

function TrendIndicator({ trend }) {
  if (trend == null || Math.abs(trend) < 1.5) return null;
  if (trend > 0) {
    return <span className="text-green-400 text-xs ml-1" title={`Rising +${trend.toFixed(1)} picks`}>▲{trend.toFixed(1)}</span>;
  }
  return <span className="text-red-400 text-xs ml-1" title={`Falling ${trend.toFixed(1)} picks`}>▼{Math.abs(trend).toFixed(1)}</span>;
}

/**
 * What the model's projection is actually made of, for the cell tooltip. The breakdown
 * is stored as JSON on the row, so a number nobody can interrogate never appears on the
 * board — this is the board's own model, with no second source to check it against.
 */
/**
 * The market's season line, spelled out. Worth showing the components rather than just
 * the total, because the total is only as trustworthy as the lines behind it — a player
 * priced for receiving yards but not touchdowns scores low here for a reason that has
 * nothing to do with the market's opinion of him.
 */
function marketTitle(player) {
  const parts = [`Betting market: ${player.mkt_points.toFixed(0)} half-PPR points from its season over/unders`];
  const bits = [];
  const add = (v, unit) => { if (v != null) bits.push(`${v} ${unit}`); };
  add(player.mkt_pass_yards, 'pass yds');
  add(player.mkt_pass_tds, 'pass TD');
  add(player.mkt_rush_yards, 'rush yds');
  add(player.mkt_rush_tds, 'rush TD');
  add(player.mkt_rec_yards, 'rec yds');
  add(player.mkt_rec_tds, 'rec TD');
  add(player.mkt_receptions, 'rec');
  if (bits.length) parts.push(bits.join(' · '));
  if (!player.mkt_complete) {
    // The books price receiving for the pass-catching backs and skip the rest, so this
    // total is missing a category the player really scores in. Not an error and not a
    // zero — the market simply saw no liquidity there.
    parts.push('PARTIAL — the books price no season line for every category he scores in, '
      + 'so this total is missing one and reads low. Not comparable with a full total');
  }
  if (player.mkt_adjusted > 0) {
    // The one place a distribution assumption enters this column, so it is said out loud.
    parts.push(`${player.mkt_adjusted} of these ${player.mkt_adjusted === 1 ? 'line is' : 'lines are'} `
      + 'the median the market\'s price implies rather than the number it posts — a line at long '
      + 'odds is a threshold, not an expectation');
  }
  if (player.mkt_books != null) {
    parts.push(player.mkt_books >= 5
      ? `every line here is priced by at least ${player.mkt_books} books`
      : `one of these lines comes from just ${player.mkt_books} book${player.mkt_books === 1 ? '' : 's'} — a thin consensus`);
  }
  // The one category with no season market at all, and it only bites quarterbacks.
  if (player.position === 'QB') {
    parts.push('no interception market exists, so this reads about two dozen points high for a quarterback');
  }
  if (player.xfp_points != null) {
    const gap = player.xfp_points - player.mkt_points;
    parts.push(Math.abs(gap) < 15
      ? 'the model agrees with it to within 15 points'
      : `the model has him ${Math.abs(gap).toFixed(0)} points ${gap > 0 ? 'higher' : 'lower'}`
        + ' — and note the market line already discounts for games it expects him to miss,'
        + ' while the model assumes a full season');
  }
  return parts.join(' · ');
}

function xfpTitle(player) {
  let parts = [`Model projection: ${player.xfp_points?.toFixed(0)} half-PPR points`];
  if (player.xfp_pos_rank != null) parts[0] += ` (${player.position}${player.xfp_pos_rank})`;
  // A full season unless the depth chart splits the job, which is only quarterbacks.
  if (player.xfp_games != null) {
    parts.push(player.xfp_games >= 16.9
      ? 'over a full season — the model does not forecast injuries'
      : `over ${player.xfp_games.toFixed(1)} games, his share of the job on the depth chart`);
  }

  let c = null;
  try {
    c = player.xfp_components ? JSON.parse(player.xfp_components) : null;
  } catch { /* a malformed breakdown must not take the tooltip down */ }

  if (c) {
    if (c.basis) parts.push(c.basis + (c.draft_ovr ? ` (pick ${c.draft_ovr})` : ''));
    else {
      const bits = [];
      if (c.targets_pg) bits.push(`${c.targets_pg.toFixed(1)} targets/g`);
      if (c.carries_pg) bits.push(`${c.carries_pg.toFixed(1)} carries/g`);
      if (c.attempts_pg) bits.push(`${c.attempts_pg.toFixed(1)} pass att/g`);
      if (bits.length) parts.push(bits.join(', '));
    }
    if (c.env_total != null) {
      parts.push(`${c.env_team} priced for ${c.env_total} points a game${c.env_source === 'market' ? '' : ` (${c.env_source})`}`);
    }
  }
  if (player.xfp_confidence === 'low') parts.push('low confidence — thin or no recent usage');
  return parts.join(' · ');
}

// score = market position rank − projected position rank. Positive means the market
// drafts him later than the projections rank him.
function ValueBadge({ score, position }) {
  if (score == null) return null;
  if (score >= 12) {
    return (
      <span
        className="ml-1.5 text-[10px] px-1 py-0.5 rounded bg-green-500/20 text-green-400 border border-green-500/30 font-bold"
        title={`Projected ${score} spots higher at ${position} than his draft cost`}
      >
        VALUE
      </span>
    );
  }
  if (score <= -12) {
    return (
      <span
        className="ml-1.5 text-[10px] px-1 py-0.5 rounded bg-amber-500/20 text-amber-400 border border-amber-500/30 font-bold"
        title={`Drafted ${Math.abs(score)} spots higher at ${position} than his projection`}
      >
        REACH
      </span>
    );
  }
  return null;
}

export default function PlayerRow({
  player, index, onUpdate, onOpenModal, columns = [],
  format = 'BB', leagueType = '1QB', sleeperBaseline = null, draftUrl = null,
  replacement = null,
}) {
  const [copied, setCopied] = useState(false);
  const [editingRank, setEditingRank] = useState(false);
  const [rankInput, setRankInput] = useState('');
  const rankRef = useRef(null);

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: player.id });

  const style = { transform: CSS.Transform.toString(transform), transition };

  const cycleTier = (e) => {
    e.stopPropagation();
    const tiers = [null, 1, 2, 3, 4, 5];
    const idx = tiers.indexOf(player.tier ?? null);
    onUpdate(player.id, { tier: tiers[(idx + 1) % tiers.length] });
  };

  const startEditRank = () => {
    setRankInput(player.personal_rank ?? '');
    setEditingRank(true);
    setTimeout(() => rankRef.current?.select(), 0);
  };

  const commitRank = () => {
    setEditingRank(false);
    const val = parseInt(rankInput, 10);
    if (!isNaN(val) && val > 0) onUpdate(player.id, { personal_rank: val });
  };

  // Where the Sleeper baseline is a stand-in, whole positions carry a standing offset,
  // so the gap is read against its position's norm rather than against zero.
  const gapNorm = (sleeperBaseline?.positional_norms?.[player.position]) ?? 0;
  const gapVsNorm = player.sleeper_gap == null ? null : player.sleeper_gap - gapNorm;

  // FantasyPros publishes real expert tiers. They sit on their own scale (theirs run
  // well past five) so they do not drive the badge, but they are worth naming where the
  // badge explains itself.
  const fpTierNote = player.fp_tier != null
    ? ` · FantasyPros put him in their tier ${player.fp_tier}`
    : '';

  // Position rank in the format currently on screen, not whichever source ranked
  // him highest.
  const posRankStr = player.pos_rank_consensus != null
    ? `${player.position}${player.pos_rank_consensus}`
    : '–';

  const rowClass = [
    'table-row-base group',
    player.drafted ? 'opacity-40' : '',
    player.flagged && !player.drafted ? 'bg-red-950/20' : '',
    player.tier ? TIER_BORDER[player.tier] : 'border-l-2 border-l-transparent',
    isDragging ? 'opacity-50 bg-[#2a2d3e] z-50' : '',
  ].filter(Boolean).join(' ');

  const cellClass = 'px-2 py-2 text-sm';

  // Build cell renderers keyed by column key
  const cellRenderers = {
    drag: (
      <td key="drag" className="px-1 py-2 w-6">
        <div
          {...attributes}
          {...listeners}
          className="cursor-grab active:cursor-grabbing text-[#2e3148] hover:text-[#555875] select-none text-center"
          title="Drag to reorder"
        >
          ⠿
        </div>
      </td>
    ),

    my_rank: (
      <td key="my_rank" className={`${cellClass} w-14`}>
        {editingRank ? (
          <input
            ref={rankRef}
            type="number"
            value={rankInput}
            onChange={e => setRankInput(e.target.value)}
            onBlur={commitRank}
            onKeyDown={e => { if (e.key === 'Enter') commitRank(); if (e.key === 'Escape') setEditingRank(false); }}
            className="w-12 bg-[#222535] border border-blue-500 rounded px-1 text-sm font-mono text-center focus:outline-none"
          />
        ) : (
          <span
            onClick={startEditRank}
            className="font-mono text-[#e8eaf0] cursor-text hover:text-blue-400 w-10 inline-block text-right"
            title="Click to edit rank"
          >
            {player.personal_rank ?? '–'}
          </span>
        )}
      </td>
    ),

    rank: (
      <td key="rank" className={`${cellClass} w-10 font-mono text-[#555875] text-right`}>
        {index + 1}
      </td>
    ),

    name: (
      <td key="name" className={`${cellClass} min-w-[160px]`}>
        <div className={`font-medium flex items-center flex-wrap gap-x-1 ${player.drafted ? 'line-through text-[#555875]' : 'text-[#e8eaf0]'}`}>
          <span>{player.name}</span>
          {player.starred && <span className="text-amber-400 text-xs">⭐</span>}
          {player.flagged && <span className="text-red-400 text-xs">🚩</span>}
          <ValueBadge score={player.value_score} position={player.position} />
        </div>
        {player.nfl_team && (
          <div className="text-xs text-[#555875] font-mono">{player.nfl_team}</div>
        )}
      </td>
    ),

    pos: (
      <td key="pos" className={`${cellClass} w-14`}>
        <span className={`pos-badge pos-${player.position}`}>{player.position}</span>
      </td>
    ),

    bye: (
      <td key="bye" className={`${cellClass} w-10 font-mono text-[#8b90a8] text-center`}>
        {player.bye_week ?? '–'}
      </td>
    ),

    consensus: (
      <td key="consensus" className={`${cellClass} w-20 font-mono text-[#e8eaf0] text-right`}>
        {player.adp_consensus != null ? (
          <span
            title={
              format === 'DYN'
                ? `Mean rank across ${player.adp_source_count || 1} dynasty value source${(player.adp_source_count || 1) !== 1 ? 's' : ''}`
                : `Mean ADP across ${player.adp_source_count || 1} source${(player.adp_source_count || 1) !== 1 ? 's' : ''}`
            }
            className="cursor-default"
          >
            {player.adp_consensus.toFixed(1)}
            {format !== 'DYN' && <TrendIndicator trend={player.adp_trend} />}
          </span>
        ) : <span className="text-[#555875]">–</span>}
      </td>
    ),

    projected_pts: (
      <td key="projected_pts" className={`${cellClass} w-16 font-mono text-right`}>
        {player.projected_pts != null ? (
          <span
            className={`pos-text-${player.position}`}
            title={`Projected 0.5 PPR points — Sleeper ${SEASON_YEAR}${player.proj_pos_rank != null ? ` (${player.position}${player.proj_pos_rank})` : ''}`}
          >
            {player.projected_pts.toFixed(1)}
          </span>
        ) : <span className="text-[#555875]">–</span>}
      </td>
    ),

    // The model's own projection. Coloured by how much of it rests on real evidence:
    // a rookie priced off draft capital alone should not read the same as a starter
    // with three seasons of usage behind him.
    xfp_points: (
      <td key="xfp_points" className={`${cellClass} w-16 font-mono text-right`}>
        {player.xfp_points != null ? (
          <span
            className={player.xfp_confidence === 'low' ? 'text-[#8b90a8] italic' : `pos-text-${player.position}`}
            title={xfpTitle(player)}
          >
            {player.xfp_points.toFixed(0)}
          </span>
        ) : <span className="text-[#555875]">–</span>}
      </td>
    ),

    // Value over replacement — the model's cross-position number, and the one worth
    // drafting on. Raw points cannot be compared across positions at all: a quarterback
    // out-scores every running back and is still not the better pick.
    xfp_vor: (
      <td key="xfp_vor" className={`${cellClass} w-16 font-mono text-right`}>
        {player.xfp_vor == null ? (
          <span className="text-[#555875]">–</span>
        ) : (
          <span
            className={player.xfp_vor > 0 ? 'text-[#e8eaf0]' : 'text-[#555875]'}
            title={
              `${player.xfp_vor.toFixed(0)} points more than a replacement ${player.position} over the season`
              + (replacement?.[player.position] != null
                ? ` — the last ${player.position} worth starting in this league projects ${replacement[player.position].toFixed(0)}`
                : '')
              + '. This is the number to compare across positions; raw points are not comparable.'
            }
          >
            {player.xfp_vor.toFixed(0)}
          </span>
        )}
      </td>
    ),

    // Best-ball ceiling. Best ball starts your best players each week automatically, so
    // a spike week is worth more than a steady one and the ceiling is closer to what you
    // are actually buying than the mean is.
    xfp_ceiling: (
      <td key="xfp_ceiling" className={`${cellClass} w-16 font-mono text-right`}>
        {player.xfp_ceiling != null ? (
          <span
            className="text-[#8b90a8]"
            title={
              `Upside season: ${player.xfp_ceiling.toFixed(0)} points, against a projection of `
              + `${player.xfp_points != null ? player.xfp_points.toFixed(0) : '?'} and a downside of `
              + `${player.xfp_floor != null ? player.xfp_floor.toFixed(0) : '?'}`
              + (player.xfp_best_ball != null
                ? `. Counting only his best weeks, as best ball does: ${player.xfp_best_ball.toFixed(0)}`
                : '')
              + '. From simulating the season week by week. Read it as the range if he holds '
              + 'his role — the model does not forecast who gets injured, so this is not a '
              + 'percentile of every outcome.'
            }
          >
            {player.xfp_ceiling.toFixed(0)}
          </span>
        ) : <span className="text-[#555875]">–</span>}
      </td>
    ),

    // Where the model and the market disagree, across the whole board rather than
    // within a position. This is the arbitrage number: positive means the model would
    // draft him earlier than the room is.
    xfp_edge: (
      <td key="xfp_edge" className={`${cellClass} w-14 font-mono text-right`}>
        {player.xfp_edge == null || Math.abs(player.xfp_edge) < 25 ? (
          <span
            className="text-[#555875]"
            title={player.xfp_edge == null
              ? 'Not enough to compare — he needs both a projection and a consensus number, and to be inside the range that actually gets drafted'
              : `The model and the market are within ${Math.abs(player.xfp_edge)} places of each other on him. `
                + 'Only gaps of 25 places — about two rounds — get a number.'}
          >
            {player.xfp_edge == null ? '–' : '·'}
          </span>
        ) : (
          <span
            className={player.xfp_edge > 0 ? 'text-green-400' : 'text-amber-400'}
            title={(player.xfp_edge > 0
              ? `The model ranks him ${player.xfp_edge} places higher than the market is drafting him — a buy, if you believe the projection`
              : `The market is drafting him ${Math.abs(player.xfp_edge)} places higher than the model ranks him — a fade`)
              + (player.position === 'QB'
                ? '. Read quarterbacks here with care: value over replacement judges them against the last startable QB, and best ball makes you roster two or three whatever that says.'
                : '')}
          >
            {player.xfp_edge > 0 ? `+${player.xfp_edge}` : player.xfp_edge}
          </span>
        )}
      </td>
    ),

    // Points per game — the model's real claim. The season total is this times a full
    // season, so this is the number that is free of any assumption about availability.
    xfp_ppg: (
      <td key="xfp_ppg" className={`${cellClass} w-14 font-mono text-right`}>
        {player.xfp_ppg != null ? (
          <span
            className={player.xfp_confidence === 'low' ? 'text-[#8b90a8] italic' : `pos-text-${player.position}`}
            title={`${player.xfp_ppg.toFixed(1)} half-PPR points per game he plays. `
              + 'The season figure beside it is this over a full seventeen games — the model '
              + 'does not try to predict who gets injured, so the rate is the honest comparison '
              + 'between two players.'}
          >
            {player.xfp_ppg.toFixed(1)}
          </span>
        ) : <span className="text-[#555875]">–</span>}
      </td>
    ),

    // The betting market's own season total for him, scored under this league's rules.
    // Deliberately shown next to the model rather than folded into it: this number is an
    // expected value that already discounts the games the books think he will miss, and
    // the model's is a full season on purpose. Where they diverge sharply, the books are
    // usually saying something about availability rather than about talent.
    mkt_points: (
      <td key="mkt_points" className={`${cellClass} w-16 font-mono text-right`}>
        {player.mkt_points != null ? (
          <span
            className={player.mkt_complete ? 'text-[#8b90a8]' : 'text-[#555875] italic'}
            title={marketTitle(player)}
          >
            {player.mkt_points.toFixed(0)}{player.mkt_complete ? '' : '*'}
          </span>
        ) : (
          <span
            className="text-[#555875]"
            title="No season-long betting line published for him. The books price roughly the top 100 skill players and 31 quarterbacks; everyone else is unpriced, which is itself a signal about how the market sees him."
          >–</span>
        )}
      </td>
    ),

    ktc_value: (
      <td key="ktc_value" className={`${cellClass} w-20 font-mono text-[#8b90a8] text-right`}>
        {player.ktc_value != null ? player.ktc_value.toLocaleString() : <span className="text-[#555875]">–</span>}
      </td>
    ),

    round: (
      <td key="round" className={`${cellClass} w-11 font-mono text-[#8b90a8] text-center`}>
        {player.round != null ? player.round : '–'}
      </td>
    ),

    // How this player sits on Sleeper against the consensus. Positive means Sleeper
    // drafts him later, so he comes cheaper in the room you are actually drafting in.
    sleeper_gap: (
      <td key="sleeper_gap" className={`${cellClass} w-16 font-mono text-right`}>
        {gapVsNorm == null || Math.abs(gapVsNorm) < 5 ? (
          <span
            className="text-[#555875]"
            title={gapVsNorm == null
              ? 'Sleeper publishes no ranking for him in this format'
              : `Sleeper and your consensus are within ${Math.abs(gapVsNorm)} places of each `
                + 'other on him, so there is no edge either way. Only gaps of 5 places or '
                + 'more get a number.'}
          >
            {gapVsNorm == null ? '–' : '·'}
          </span>
        ) : (
          <span
            className={gapVsNorm > 0 ? 'text-green-400' : 'text-amber-400'}
            title={(gapVsNorm > 0
              ? `Sleeper drafts him ${gapVsNorm} places later than the consensus — cheaper there`
              : `Sleeper drafts him ${Math.abs(gapVsNorm)} places earlier than the consensus — dearer there`)
              + (gapNorm !== 0
                ? `. Measured against the ${gapNorm > 0 ? '+' : ''}${gapNorm} that every ${player.position} carries here, because Sleeper publishes no best-ball board and this baseline is its ½PPR redraft ADP`
                : '')}
          >
            {gapVsNorm > 0 ? `+${gapVsNorm}` : gapVsNorm}
          </span>
        )}
      </td>
    ),

    // How far apart the selected sources are on him.
    spread: (
      <td key="spread" className={`${cellClass} w-16 font-mono text-right`}>
        {player.spread == null ? (
          <span className="text-[#555875]">–</span>
        ) : (
          <span
            className={player.spread >= 24 ? 'text-orange-400' : player.spread >= 12 ? 'text-[#8b90a8]' : 'text-[#555875]'}
            title={`Your sources are ${player.spread} places apart on him`}
          >
            {player.spread.toFixed(0)}
          </span>
        )}
      </td>
    ),

    age: (
      <td key="age" className={`${cellClass} w-12 font-mono text-[#8b90a8] text-center`}>
        {player.age != null ? player.age.toFixed(0) : '–'}
      </td>
    ),

    pos_rank: (
      <td key="pos_rank" className={`${cellClass} w-16 font-mono text-[#8b90a8] text-center`}>
        {posRankStr}
      </td>
    ),

    tier: (
      <td key="tier" className={`${cellClass} w-14 text-center`}>
        {player.tier ? (
          <button
            onClick={cycleTier}
            className={`tier-badge w-7 h-7 text-xs tier-${player.tier}`}
            title={`Your own tier ${player.tier}${fpTierNote} · click to cycle`}
          >
            T{player.tier}
          </button>
        ) : player.tier_auto ? (
          <button
            onClick={cycleTier}
            className="tier-badge w-7 h-7 text-xs border-dashed border-[#2e3148] text-[#555875] hover:text-[#8b90a8] opacity-50"
            title={`Tier ${player.tier_auto}, drawn from where his consensus number falls: the bands are the first half round, then rounds 1½, 3 and 6 at this league size. Not anyone’s expert tiers${fpTierNote}. Dashed because it is automatic — click to set your own.`}
          >
            T{player.tier_auto}
          </button>
        ) : (
          <button
            onClick={cycleTier}
            className="tier-badge w-7 h-7 text-xs border-[#2e3148] text-[#555875] hover:text-[#8b90a8]"
            title="Click to set tier"
          >
            –
          </button>
        )}
      </td>
    ),

    flags: (
      <td key="flags" className={`${cellClass} w-16`}>
        <div className="flex gap-1">
          <button
            onClick={() => onUpdate(player.id, { starred: !player.starred })}
            className={`text-sm transition-colors ${player.starred ? 'text-amber-400' : 'text-[#2e3148] hover:text-amber-400/60'}`}
            title={player.starred ? 'Unstar' : 'Star'}
          >
            ★
          </button>
          <button
            onClick={() => onUpdate(player.id, { flagged: !player.flagged })}
            className={`text-sm transition-colors ${player.flagged ? 'text-red-400' : 'text-[#2e3148] hover:text-red-400/60'}`}
            title={player.flagged ? 'Unflag' : 'Flag concern'}
          >
            ⚑
          </button>
        </div>
      </td>
    ),

    // A player taken in a connected Sleeper draft shows the pick that took him instead
    // of the manual toggle: the tick is not the user's to undo, and the pick number is
    // the more useful fact anyway. Disconnecting the draft brings the toggle back.
    status: (
      <td key="status" className={`${cellClass} w-24`}>
        {player.draft_pick_no != null ? (
          <span
            className={`text-xs px-2 py-0.5 rounded border block truncate ${
              player.drafted_by_me
                ? 'bg-green-500/20 text-green-300 border-green-500/40'
                : 'bg-[#222535] text-[#8b90a8] border-[#2e3148]'
            }`}
            title={`Pick ${player.draft_pick_no}`
              + (player.draft_round ? `, round ${player.draft_round}` : '')
              + (player.drafted_by ? ` — ${player.drafted_by}` : '')
              + (player.drafted_by_me ? ' (yours)' : '')}
          >
            #{player.draft_pick_no} {player.drafted_by_me ? 'you' : player.drafted_by}
          </span>
        ) : (
          <button
            onClick={() => onUpdate(player.id, { drafted: !player.drafted })}
            className={`text-xs px-2 py-0.5 rounded border transition-colors ${
              player.drafted
                ? 'bg-green-500/20 text-green-400 border-green-500/40'
                : 'border-[#2e3148] text-[#555875] hover:border-[#555875] hover:text-[#8b90a8]'
            }`}
          >
            {player.drafted ? '✓ Drafted' : 'Available'}
          </button>
        )}
      </td>
    ),

    // Sleeper takes no picks from outside its own app, so this does the next best thing:
    // copies the name and opens the draft room, leaving a paste into its search box.
    // Copying is best-effort — an older browser or an insecure origin just gets the link.
    go: (
      <td key="go" className={`${cellClass} w-9 text-center`}>
        <a
          href={draftUrl || 'https://sleeper.com'}
          target="_blank"
          rel="noreferrer"
          onClick={() => {
            navigator.clipboard?.writeText(player.name).then(
              () => { setCopied(true); setTimeout(() => setCopied(false), 2000); },
              () => {},
            );
          }}
          className={`text-sm transition-colors ${copied ? 'text-green-400' : 'text-[#2e3148] hover:text-blue-400'}`}
          title={`Copy "${player.name}" and open the draft room on Sleeper — paste it into the search box there`}
        >
          {copied ? '✓' : '↗'}
        </a>
      </td>
    ),

    notes: (
      <td key="notes" className={`${cellClass} w-12 text-center`}>
        <button
          onClick={() => onOpenModal(player)}
          className={`text-sm transition-colors hover:text-blue-400 ${
            (player.note_upside || player.note_downside || player.note_sources || player.note_personal)
              ? 'text-blue-400'
              : 'text-[#2e3148]'
          }`}
          title="Open notes"
        >
          📝
        </button>
      </td>
    ),
  };

  // Source columns are driven by the server's view descriptor, so anything without a
  // bespoke renderer is a numeric source cell keyed by its field name.
  const renderCell = (col) => {
    if (cellRenderers[col.key]) return cellRenderers[col.key];
    const value = player[col.key];
    return (
      <td key={col.key} className={`${cellClass} font-mono text-[#8b90a8] text-right`}>
        {value == null
          ? <span className="text-[#555875]">–</span>
          : value >= 1000 ? value.toLocaleString() : value.toFixed(1)}
      </td>
    );
  };

  return (
    <tr ref={setNodeRef} style={style} className={rowClass}>
      {columns.map(renderCell)}
    </tr>
  );
}
