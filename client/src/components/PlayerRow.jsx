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
  format = 'BB', leagueType = '1QB', sleeperBaseline = null,
}) {
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
          <span className="text-[#555875]">{gapVsNorm == null ? '–' : '·'}</span>
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
            title="Click to cycle tier"
          >
            T{player.tier}
          </button>
        ) : player.tier_auto ? (
          <button
            onClick={cycleTier}
            className="tier-badge w-7 h-7 text-xs border-dashed border-[#2e3148] text-[#555875] hover:text-[#8b90a8] opacity-50"
            title={`Auto-tier T${player.tier_auto} (ADP-based) · click to set`}
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

    status: (
      <td key="status" className={`${cellClass} w-24`}>
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
