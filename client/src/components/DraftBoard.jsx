import React, { useState, useCallback } from 'react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragOverlay,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import PlayerRow from './PlayerRow';

// Build the visible column list based on format and which sources are toggled on
function buildColumns(format, leagueType, enabledSources, sourceStatus) {
  // Dynamic label for the UD column based on which source actually provided data
  const udNote = sourceStatus?.underdog?.notes;
  const udLabel = udNote === 'FFC' ? 'FFC*' : udNote === 'DraftSharks' ? 'DS' : 'UD';

  const base = [
    { label: '', width: 'w-6', key: 'drag' },
    { label: 'My #', width: 'w-14', key: 'my_rank' },
    { label: '#', width: 'w-10', key: 'rank' },
    { label: 'Name', width: 'min-w-[160px]', key: 'name' },
    { label: 'Pos', width: 'w-14', key: 'pos' },
    { label: 'Bye', width: 'w-10', key: 'bye' },
  ];

  const tail = [
    { label: 'Tier', width: 'w-14', key: 'tier' },
    { label: 'Flags', width: 'w-16', key: 'flags' },
    { label: 'Status', width: 'w-24', key: 'status' },
    { label: 'Notes', width: 'w-12', key: 'notes' },
  ];

  if (format === 'DYN') {
    return [
      ...base,
      ...(enabledSources.ktc ? [{ label: 'KTC', width: 'w-20', key: 'ktc_value' }] : []),
      ...(enabledSources.fantasycalc ? [{ label: 'FC', width: 'w-20', key: 'fc_value' }] : []),
      ...(enabledSources.sleeper ? [{ label: 'Proj', width: 'w-16', key: 'projected_pts' }] : []),
      { label: 'Pos Rk', width: 'w-16', key: 'pos_rank' },
      ...tail,
    ];
  }

  // Best Ball and Redraft
  return [
    ...base,
    ...(enabledSources.fantasypros ? [{ label: 'FP', width: 'w-16', key: 'adp_fp' }] : []),
    ...(enabledSources.underdog ? [{ label: udLabel, width: 'w-16', key: 'adp_ud' }] : []),
    ...(enabledSources.ffc ? [{ label: 'FFC', width: 'w-16', key: 'adp_ffc' }] : []),
    ...(enabledSources.sleeper ? [{ label: 'SL', width: 'w-16', key: 'adp_sl' }] : []),
    { label: 'Consensus', width: 'w-20', key: 'consensus' },
    { label: 'Proj', width: 'w-16', key: 'projected_pts' },
    { label: 'Pos Rk', width: 'w-16', key: 'pos_rank' },
    ...tail,
  ];
}

function SkeletonRow({ colCount }) {
  return (
    <tr className="border-b border-[#1e2132]">
      {Array.from({ length: colCount }).map((_, i) => (
        <td key={i} className="px-2 py-3">
          <div className="h-3 bg-[#1e2132] rounded animate-pulse" style={{ width: i === 3 ? '140px' : '40px' }} />
        </td>
      ))}
    </tr>
  );
}

export default function DraftBoard({
  players, loading, onUpdate, onOpenModal, onReorder,
  format = 'BB', leagueType = '1QB', enabledSources = {}, sourceStatus = {},
}) {
  const [activeId, setActiveId] = useState(null);

  const columns = buildColumns(format, leagueType, enabledSources, sourceStatus);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const handleDragStart = useCallback((event) => setActiveId(event.active.id), []);

  const handleDragEnd = useCallback((event) => {
    const { active, over } = event;
    setActiveId(null);
    if (!over || active.id === over.id) return;
    const overIndex = players.findIndex(p => p.id === over.id);
    if (overIndex === -1) return;
    onReorder(active.id, overIndex + 1);
  }, [players, onReorder]);

  const activePlayer = activeId ? players.find(p => p.id === activeId) : null;

  const headerRow = (
    <tr className="border-b border-[#2e3148]" style={{ position: 'sticky', top: 'var(--filter-bar-height, 53px)', backgroundColor: '#0f1117', zIndex: 20 }}>
      {columns.map((col, i) => (
        <th
          key={i}
          className={`${col.width} px-2 py-2 text-left text-xs font-semibold text-[#555875] uppercase tracking-wider`}
        >
          {col.label}
        </th>
      ))}
    </tr>
  );

  if (loading) {
    return (
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>{headerRow}</thead>
          <tbody>
            {Array.from({ length: 20 }).map((_, i) => (
              <SkeletonRow key={i} colCount={columns.length} />
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (players.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-[#555875]">
        <div className="text-4xl mb-3">🏈</div>
        <div className="text-lg font-medium mb-1">No players found</div>
        <div className="text-sm">Try adjusting your filters or refreshing data sources</div>
      </div>
    );
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>{headerRow}</thead>
          <SortableContext items={players.map(p => p.id)} strategy={verticalListSortingStrategy}>
            <tbody>
              {players.map((player, index) => (
                <PlayerRow
                  key={player.id}
                  player={player}
                  index={index}
                  onUpdate={onUpdate}
                  onOpenModal={onOpenModal}
                  columns={columns}
                  format={format}
                  leagueType={leagueType}
                />
              ))}
            </tbody>
          </SortableContext>
        </table>
      </div>

      <DragOverlay>
        {activePlayer && (
          <div className="bg-[#222535] border border-blue-500/50 rounded px-3 py-2 text-sm font-medium text-[#e8eaf0] shadow-xl opacity-95">
            {activePlayer.name} · {activePlayer.position}
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}
