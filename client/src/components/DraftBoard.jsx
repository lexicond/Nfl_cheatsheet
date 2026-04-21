import React, { useState, useCallback, useRef } from 'react';
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

// Pixel widths for each column key — used in colgroup for both header and body tables
const COL_PX = {
  drag: 24, my_rank: 56, rank: 40, name: 200, pos: 56, bye: 40,
  adp_fp: 64, adp_ud: 64, adp_ffc: 64, adp_sl: 64,
  consensus: 80, projected_pts: 64, pos_rank: 64,
  ktc_value: 80, fc_value: 80,
  tier: 56, flags: 64, status: 96, notes: 48,
};

function buildColumns(format, leagueType, enabledSources, sourceStatus) {
  const udNote = sourceStatus?.underdog?.notes;
  const udLabel = udNote === 'FFC' ? 'FFC*' : udNote === 'DraftSharks' ? 'DS' : 'UD';

  const base = [
    { label: '', key: 'drag' },
    { label: 'My #', key: 'my_rank' },
    { label: '#', key: 'rank' },
    { label: 'Name', key: 'name' },
    { label: 'Pos', key: 'pos' },
    { label: 'Bye', key: 'bye' },
  ];

  const tail = [
    { label: 'Tier', key: 'tier' },
    { label: 'Flags', key: 'flags' },
    { label: 'Status', key: 'status' },
    { label: 'Notes', key: 'notes' },
  ];

  if (format === 'DYN') {
    return [
      ...base,
      ...(enabledSources.ktc !== false ? [{ label: 'KTC', key: 'ktc_value' }] : []),
      ...(enabledSources.fantasycalc !== false ? [{ label: 'FC', key: 'fc_value' }] : []),
      ...(enabledSources.sleeper !== false ? [{ label: 'Proj', key: 'projected_pts' }] : []),
      { label: 'Pos Rk', key: 'pos_rank' },
      ...tail,
    ];
  }

  return [
    ...base,
    ...(enabledSources.fantasypros !== false ? [{ label: 'FP', key: 'adp_fp' }] : []),
    ...(enabledSources.underdog !== false ? [{ label: udLabel, key: 'adp_ud' }] : []),
    ...(enabledSources.ffc !== false ? [{ label: 'FFC', key: 'adp_ffc' }] : []),
    ...(enabledSources.sleeper !== false ? [{ label: 'SL', key: 'adp_sl' }] : []),
    { label: 'Consensus', key: 'consensus' },
    { label: 'Proj', key: 'projected_pts' },
    { label: 'Pos Rk', key: 'pos_rank' },
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

function TableColgroup({ columns }) {
  return (
    <colgroup>
      {columns.map(col => (
        <col key={col.key} style={{ width: COL_PX[col.key] || 64, minWidth: COL_PX[col.key] || 64 }} />
      ))}
    </colgroup>
  );
}

function HeaderRow({ columns }) {
  return (
    <tr>
      {columns.map(col => (
        <th
          key={col.key}
          className="px-2 py-2 text-left text-xs font-semibold text-[#555875] uppercase tracking-wider"
        >
          {col.label}
        </th>
      ))}
    </tr>
  );
}

export default function DraftBoard({
  players, loading, onUpdate, onOpenModal, onReorder,
  format = 'BB', leagueType = '1QB', enabledSources = {}, sourceStatus = {},
  filterBarHeight = 53,
}) {
  const [activeId, setActiveId] = useState(null);
  const headerScrollRef = useRef(null);
  const bodyScrollRef = useRef(null);

  const columns = buildColumns(format, leagueType, enabledSources, sourceStatus);
  const totalWidth = columns.reduce((sum, col) => sum + (COL_PX[col.key] || 64), 0);

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

  // Sync horizontal scroll from body to header
  const onBodyScroll = useCallback(() => {
    if (headerScrollRef.current && bodyScrollRef.current) {
      headerScrollRef.current.scrollLeft = bodyScrollRef.current.scrollLeft;
    }
  }, []);

  const activePlayer = activeId ? players.find(p => p.id === activeId) : null;

  const tableStyle = { width: totalWidth, minWidth: totalWidth, borderCollapse: 'collapse', tableLayout: 'fixed' };

  // Sticky header — positioned outside the overflow container so sticky works correctly
  const stickyHeader = (
    <div
      style={{
        position: 'sticky',
        top: filterBarHeight,
        zIndex: 20,
        backgroundColor: '#0f1117',
        borderBottom: '1px solid #2e3148',
      }}
    >
      <div ref={headerScrollRef} style={{ overflowX: 'hidden' }}>
        <table style={tableStyle}>
          <TableColgroup columns={columns} />
          <thead>
            <HeaderRow columns={columns} />
          </thead>
        </table>
      </div>
    </div>
  );

  if (loading) {
    return (
      <>
        {stickyHeader}
        <div style={{ overflowX: 'auto' }}>
          <table style={tableStyle}>
            <TableColgroup columns={columns} />
            <tbody>
              {Array.from({ length: 20 }).map((_, i) => (
                <SkeletonRow key={i} colCount={columns.length} />
              ))}
            </tbody>
          </table>
        </div>
      </>
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
      {stickyHeader}

      <div ref={bodyScrollRef} style={{ overflowX: 'auto' }} onScroll={onBodyScroll}>
        <table style={tableStyle}>
          <TableColgroup columns={columns} />
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
