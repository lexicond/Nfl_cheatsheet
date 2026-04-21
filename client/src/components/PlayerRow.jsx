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

function bestPosRank(player) {
  const ranks = [
    player.pos_rank_fantasypros,
    player.pos_rank_underdog,
    player.pos_rank_sleeper,
  ].filter(r => r != null);
  if (ranks.length === 0) return null;
  return Math.min(...ranks);
}

export default function PlayerRow({ player, index, onUpdate, onOpenModal }) {
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

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const cycleTier = (e) => {
    e.stopPropagation();
    const tiers = [null, 1, 2, 3, 4, 5];
    const current = player.tier ?? null;
    const idx = tiers.indexOf(current);
    const next = tiers[(idx + 1) % tiers.length];
    onUpdate(player.id, { tier: next });
  };

  const startEditRank = () => {
    setRankInput(player.personal_rank ?? '');
    setEditingRank(true);
    setTimeout(() => rankRef.current?.select(), 0);
  };

  const commitRank = () => {
    setEditingRank(false);
    const val = parseInt(rankInput, 10);
    if (!isNaN(val) && val > 0) {
      onUpdate(player.id, { personal_rank: val });
    }
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

  return (
    <tr ref={setNodeRef} style={style} className={rowClass}>
      {/* Drag handle */}
      <td className="px-1 py-2 w-6">
        <div
          {...attributes}
          {...listeners}
          className="cursor-grab active:cursor-grabbing text-[#2e3148] hover:text-[#555875] select-none text-center"
          title="Drag to reorder"
        >
          ⠿
        </div>
      </td>

      {/* My Rank */}
      <td className={`${cellClass} w-14`}>
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

      {/* Consensus rank (index) */}
      <td className={`${cellClass} w-10 font-mono text-[#555875] text-right`}>
        {index + 1}
      </td>

      {/* Name + team */}
      <td className={`${cellClass} min-w-[160px]`}>
        <div className={`font-medium ${player.drafted ? 'line-through text-[#555875]' : 'text-[#e8eaf0]'}`}>
          {player.name}
          {player.starred && <span className="ml-1 text-amber-400 text-xs">⭐</span>}
          {player.flagged && <span className="ml-1 text-red-400 text-xs">🚩</span>}
        </div>
        {player.nfl_team && (
          <div className="text-xs text-[#555875] font-mono">{player.nfl_team}</div>
        )}
      </td>

      {/* Position badge */}
      <td className={`${cellClass} w-14`}>
        <span className={`pos-badge pos-${player.position}`}>{player.position}</span>
      </td>

      {/* Bye */}
      <td className={`${cellClass} w-10 font-mono text-[#8b90a8] text-center`}>
        {player.bye_week ?? '–'}
      </td>

      {/* FP ADP */}
      <td className={`${cellClass} w-16 font-mono text-[#8b90a8] text-right`}>
        <AdpCell value={player.adp_fantasypros} />
      </td>

      {/* UD ADP */}
      <td className={`${cellClass} w-16 font-mono text-[#8b90a8] text-right`}>
        <AdpCell value={player.adp_underdog} />
      </td>

      {/* SL ADP */}
      <td className={`${cellClass} w-16 font-mono text-[#8b90a8] text-right`}>
        <AdpCell value={player.adp_sleeper} />
      </td>

      {/* Consensus */}
      <td className={`${cellClass} w-20 font-mono text-[#e8eaf0] text-right`}>
        {player.adp_consensus != null ? (
          <span
            title={`Based on ${player.adp_source_count || 1} source${(player.adp_source_count || 1) !== 1 ? 's' : ''}`}
            className="cursor-default"
          >
            {player.adp_consensus.toFixed(1)}
          </span>
        ) : <span className="text-[#555875]">–</span>}
      </td>

      {/* Pos Rank */}
      <td className={`${cellClass} w-16 font-mono text-[#8b90a8] text-center`}>
        {posRankStr}
      </td>

      {/* Tier */}
      <td className={`${cellClass} w-14 text-center`}>
        <button
          onClick={cycleTier}
          className={`tier-badge w-7 h-7 text-xs ${player.tier ? `tier-${player.tier}` : 'border-[#2e3148] text-[#555875] hover:text-[#8b90a8]'}`}
          title="Click to cycle tier"
        >
          {player.tier ? `T${player.tier}` : '–'}
        </button>
      </td>

      {/* Flags */}
      <td className={`${cellClass} w-16`}>
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

      {/* Status */}
      <td className={`${cellClass} w-24`}>
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

      {/* Notes */}
      <td className={`${cellClass} w-12 text-center`}>
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
    </tr>
  );
}
