import React, { useState, useCallback, useRef, useEffect } from 'react';
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
// Any column not listed falls back to 68px, which suits a right-aligned ADP number.
const COL_PX = {
  drag: 24, my_rank: 56, rank: 40, name: 200, pos: 56, bye: 40,
  adp_fp: 64, adp_ud: 64, adp_ffc: 64, adp_ffc_sf: 64,
  adp_fp_rd: 64, adp_fp_sf: 64, adp_fp_dyn: 64,
  adp_sl_rd: 64, adp_sl_sf: 64,
  adp_espn: 64, adp_yahoo: 64,
  consensus: 100, projected_pts: 64, pos_rank: 64, age: 48,
  round: 44, sleeper_gap: 60, spread: 58,
  ktc_value: 80, fc_value: 80, ds_value: 80, dp_value: 80,
  tier: 56, flags: 64, status: 96, notes: 48, go: 36,
};

// True on a phone-width screen. Watched rather than read once, so rotating the handset
// re-lays the board out instead of leaving it in the other orientation's shape.
function useNarrow() {
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 640px)').matches
  );
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 640px)');
    const on = e => setNarrow(e.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return narrow;
}

/**
 * Columns come from the server's view descriptor rather than a copy of the source
 * registry kept here — so the columns on screen are exactly the sources the server
 * says feed this view, and a source switched off disappears from both.
 *
 * On a phone the drag handle and My # go: neither can be used without a pointer, and
 * together they cost 80px that Consensus needs to be on screen at all.
 */
function buildColumns(format, view, excluded, narrow, draftConnected) {
  const base = [
    ...(narrow ? [] : [{ label: '', key: 'drag' }, { label: 'My #', key: 'my_rank' }]),
    { label: '#', key: 'rank' },
    { label: 'Name', key: 'name' },
    { label: 'Pos', key: 'pos' },
    format === 'DYN' ? { label: 'Age', key: 'age' } : { label: 'Bye', key: 'bye' },
  ];

  const tail = [
    { label: 'Tier', key: 'tier' },
    { label: 'Flags', key: 'flags' },
    { label: 'Status', key: 'status' },
    { label: 'Notes', key: 'notes' },
  ];

  // Exclusions are held by family, not column, so a market switched off stays off
  // across a view's 1QB and Superflex boards.
  const sourceCols = view
    ? [...view.consensus, ...view.reference]
        .filter(src => !excluded.includes(src.family))
        .map(src => ({ label: src.short, key: src.field, numeric: true }))
    : [];

  // "Consensus" is wider than the column it labels on a phone, and ran into its
  // neighbour. The number under it is the same number either way.
  const consensus = {
    label: format === 'DYN' ? 'Rank' : (narrow ? 'Cons' : 'Consensus'),
    key: 'consensus',
  };

  // Sleeper's API is read-only, so the pick itself has to be made in their app. This is
  // the shortest path to it: copy the name, open the room, paste, confirm. It sits ahead
  // of the numbers so it stays on screen on a phone, and only exists while a draft is
  // connected, because otherwise there is nowhere to go.
  const go = draftConnected ? [{ label: '', key: 'go' }] : [];
  const middle = [
    ...(format === 'DYN' ? [] : [{ label: 'Rd', key: 'round' }]),
    { label: 'Δ SL', key: 'sleeper_gap' },
    { label: 'Split', key: 'spread' },
    { label: 'Proj', key: 'projected_pts' },
    { label: 'Pos Rk', key: 'pos_rank' },
  ];

  // On a phone the headline number comes straight after the name. In source order it
  // starts about 460px in, which on a 390px screen means scrolling sideways to find out
  // what the board is actually ranking by. Nothing is dropped — the sources and the
  // rest still follow, they are just no longer in front of the answer.
  if (narrow) {
    return [...base, ...go, consensus, ...sourceCols, ...middle, ...tail];
  }

  return [...base, ...go, ...sourceCols, consensus, ...middle, ...tail];
}

// A phone gets tighter columns for the few that matter, so name, position and the
// headline number all land inside 390px.
const COL_PX_NARROW = { rank: 30, name: 146, pos: 50, consensus: 74, bye: 42, go: 34 };

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

// With a live draft connected, Status carries the pick and the team that made it
// rather than a one-word toggle, and 96px truncates every team name to a stub.
function colWidth(key, draftConnected, narrow) {
  if (key === 'status' && draftConnected) return narrow ? 120 : 148;
  if (narrow && COL_PX_NARROW[key]) return COL_PX_NARROW[key];
  return COL_PX[key] || 68;
}

function TableColgroup({ columns, draftConnected, narrow }) {
  return (
    <colgroup>
      {columns.map(col => {
        const w = colWidth(col.key, draftConnected, narrow);
        return <col key={col.key} style={{ width: w, minWidth: w }} />;
      })}
    </colgroup>
  );
}

function HeaderRow({ columns }) {
  return (
    <tr>
      {columns.map(col => (
        <th
          key={col.key}
          className="px-2 py-2 text-left text-xs font-semibold text-[#555875] uppercase tracking-wider overflow-hidden whitespace-nowrap text-ellipsis"
        >
          {col.label}
        </th>
      ))}
    </tr>
  );
}

export default function DraftBoard({
  players, loading, onUpdate, onOpenModal, onReorder,
  format = 'BB', leagueType = '1QB', view = null, excluded = [], sourceStatus = {},
  sleeperBaseline = null, filterBarHeight = 53, draftConnected = false, draftUrl = null,
}) {
  const [activeId, setActiveId] = useState(null);
  const headerScrollRef = useRef(null);
  const bodyScrollRef = useRef(null);

  const narrow = useNarrow();
  const columns = buildColumns(format, view, excluded, narrow, draftConnected);
  const totalWidth = columns.reduce((sum, col) => sum + colWidth(col.key, draftConnected, narrow), 0);

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
        top: narrow ? 0 : filterBarHeight,
        zIndex: 20,
        backgroundColor: '#0f1117',
        borderBottom: '1px solid #2e3148',
      }}
    >
      <div ref={headerScrollRef} style={{ overflowX: 'hidden' }}>
        <table style={tableStyle}>
          <TableColgroup columns={columns} draftConnected={draftConnected} narrow={narrow} />
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
            <TableColgroup columns={columns} draftConnected={draftConnected} narrow={narrow} />
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
          <TableColgroup columns={columns} draftConnected={draftConnected} narrow={narrow} />
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
                  draftUrl={draftUrl}
                  format={format}
                  leagueType={leagueType}
                  sleeperBaseline={sleeperBaseline}
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
