import React, { useState, useRef } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

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

function ValueBadge({ score }) {
  if (score == null) return null;
  if (score >= 15) {
    return <span className="ml-1.5 text-[10px] px-1 py-0.5 rounded bg-green-500/20 text-green-400 border border-green-500/30 font-bold">VALUE</span>;
  }
  if (score <= -15) {
    return <span className="ml-1.5 text-[10px] px-1 py-0.5 rounded bg-amber-500/20 text-amber-400 border border-amber-500/30 font-bold">REACH</span>;
  }
  return null;
}

function bestPosRank(player) {
  const ranks = [
    player.pos_rank_fantasypros,
    player.pos_rank_underdog,
    player.pos_rank_sleeper,
  ].filter(r => r != null);
  if (ranks.length === 0) return null;
  return Math.min(...ranks);
}

export default function PlayerRow({ player, index, onUpdate, onOpenModal, columns = [], format = 'BB', leagueType = '1QB' }) {
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

  const posRank = bestPosRank(player);
  const posRankStr = posRank != null ? `${player.position}${posRank}` : '–';

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
          <ValueBadge score={player.value_score} />
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

    adp_fp: (
      <td key="adp_fp" className={`${cellClass} w-16 font-mono text-[#8b90a8] text-right`}>
        <AdpCell value={player.adp_fantasypros} />
      </td>
    ),

    adp_fp_rd: (
      <td key="adp_fp_rd" className={`${cellClass} w-16 font-mono text-[#8b90a8] text-right`}>
        <AdpCell value={player.adp_fp_rd} />
      </td>
    ),

    adp_fp_sf: (
      <td key="adp_fp_sf" className={`${cellClass} w-16 font-mono text-[#8b90a8] text-right`}>
        <AdpCell value={player.adp_fp_sf} />
      </td>
    ),

    adp_ud: (
      <td key="adp_ud" className={`${cellClass} w-16 font-mono text-[#8b90a8] text-right`}>
        <AdpCell value={player.adp_underdog} />
      </td>
    ),

    adp_ffc: (
      <td key="adp_ffc" className={`${cellClass} w-16 font-mono text-[#8b90a8] text-right`}>
        <AdpCell value={player.adp_ffc} />
      </td>
    ),

    adp_sl_bb: (
      <td key="adp_sl_bb" className={`${cellClass} w-16 font-mono text-[#8b90a8] text-right`}>
        <AdpCell value={player.adp_sl_bb} />
      </td>
    ),

    adp_sl_rd: (
      <td key="adp_sl_rd" className={`${cellClass} w-16 font-mono text-[#8b90a8] text-right`}>
        <AdpCell value={player.adp_sl_rd} />
      </td>
    ),

    adp_sl_sf: (
      <td key="adp_sl_sf" className={`${cellClass} w-16 font-mono text-[#8b90a8] text-right`}>
        <AdpCell value={player.adp_sl_sf} />
      </td>
    ),

    consensus: (
      <td key="consensus" className={`${cellClass} w-20 font-mono text-[#e8eaf0] text-right`}>
        {player.adp_consensus != null ? (
          <span
            title={`Based on ${player.adp_source_count || 1} source${(player.adp_source_count || 1) !== 1 ? 's' : ''}`}
            className="cursor-default"
          >
            {player.adp_consensus.toFixed(1)}
            <TrendIndicator trend={player.adp_trend} />
          </span>
        ) : <span className="text-[#555875]">–</span>}
      </td>
    ),

    projected_pts: (
      <td key="projected_pts" className={`${cellClass} w-16 font-mono text-right`}>
        {player.projected_pts != null ? (
          <span
            className={`pos-text-${player.position}`}
            title={`Projected 0.5 PPR points (Sleeper 2025)`}
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

    fc_value: (
      <td key="fc_value" className={`${cellClass} w-20 font-mono text-[#8b90a8] text-right`}>
        {player.fc_value != null ? player.fc_value.toFixed(0) : <span className="text-[#555875]">–</span>}
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

  return (
    <tr ref={setNodeRef} style={style} className={rowClass}>
      {columns.map(col => cellRenderers[col.key] || null)}
    </tr>
  );
}
