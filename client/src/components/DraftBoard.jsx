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

const COLUMNS = [
  { label: '', width: 'w-6' },             // drag handle
  { label: 'My #', width: 'w-14' },
  { label: '#', width: 'w-10' },
  { label: 'Name', width: 'min-w-[160px]' },
  { label: 'Pos', width: 'w-14' },
  { label: 'Bye', width: 'w-10' },
  { label: 'FP', width: 'w-16' },
  { label: 'UD', width: 'w-16' },
  { label: 'SL', width: 'w-16' },
  { label: 'Consensus', width: 'w-20' },
  { label: 'Pos Rk', width: 'w-16' },
  { label: 'Tier', width: 'w-14' },
  { label: 'Flags', width: 'w-16' },
  { label: 'Status', width: 'w-24' },
  { label: 'Notes', width: 'w-12' },
];

function SkeletonRow() {
  return (
    <tr className="border-b border-[#1e2132]">
      {COLUMNS.map((col, i) => (
        <td key={i} className="px-2 py-3">
          <div className="h-3 bg-[#1e2132] rounded animate-pulse" style={{ width: i === 3 ? '140px' : '40px' }} />
        </td>
      ))}
    </tr>
  );
}

export default function DraftBoard({ players, loading, onUpdate, onOpenModal, onReorder }) {
  const [activeId, setActiveId] = useState(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const handleDragStart = useCallback((event) => {
    setActiveId(event.active.id);
  }, []);

  const handleDragEnd = useCallback((event) => {
    const { active, over } = event;
    setActiveId(null);

    if (!over || active.id === over.id) return;

    const overIndex = players.findIndex(p => p.id === over.id);
    if (overIndex === -1) return;

    // Use 1-based rank = position in the list + 1
    onReorder(active.id, overIndex + 1);
  }, [players, onReorder]);

  const activePlayer = activeId ? players.find(p => p.id === activeId) : null;

  if (loading) {
    return (
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-[#2e3148]">
              {COLUMNS.map((col, i) => (
                <th
                  key={i}
                  className={`${col.width} px-2 py-2 text-left text-xs font-semibold text-[#555875] uppercase tracking-wider`}
                >
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: 20 }).map((_, i) => <SkeletonRow key={i} />)}
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
          <thead>
            <tr className="border-b border-[#2e3148] sticky top-[53px] bg-[#0f1117] z-20">
              {COLUMNS.map((col, i) => (
                <th
                  key={i}
                  className={`${col.width} px-2 py-2 text-left text-xs font-semibold text-[#555875] uppercase tracking-wider`}
                >
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <SortableContext items={players.map(p => p.id)} strategy={verticalListSortingStrategy}>
            <tbody>
              {players.map((player, index) => (
                <PlayerRow
                  key={player.id}
                  player={player}
                  index={index}
                  onUpdate={onUpdate}
                  onOpenModal={onOpenModal}
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
