import React, { useState, useCallback, useRef, useEffect } from 'react';
import { usePlayers } from './hooks/usePlayers';
import { useDraftSync } from './hooks/useDraftSync';
import FilterBar from './components/FilterBar';
import DraftBoard from './components/DraftBoard';
import PlayerModal from './components/PlayerModal';

function Toast({ toast }) {
  if (!toast) return null;
  const colors = {
    info: 'bg-[#222535] border-blue-500/40 text-[#e8eaf0]',
    success: 'bg-[#222535] border-green-500/40 text-green-300',
    error: 'bg-[#222535] border-red-500/40 text-red-300',
    warning: 'bg-[#222535] border-amber-500/40 text-amber-300',
  };
  return (
    <div className={`fixed bottom-6 right-6 z-[100] border rounded-lg px-4 py-3 text-sm shadow-xl max-w-sm ${colors[toast.type] || colors.info}`}>
      {toast.message}
    </div>
  );
}

export default function App() {
  const {
    players,
    loading,
    filters,
    setFilter,
    updateOverride,
    refreshSource,
    reorderPlayer,
    sourceStatus,
    refreshing,
    toast,
    format,
    setFormat,
    leagueType,
    setLeagueType,
    view,
    excluded,
    toggleSource,
    enableAllSources,
    teamSize,
    setTeamSize,
    sleeperBaseline,
    xfpReplacement,
    tiers,
    refetchQuiet,
    showToast,
  } = usePlayers();

  // A pick landing in the Sleeper room has to reach the board itself, not just the
  // panel — the whole point is that the player is gone before you scroll to him.
  const onPicks = useCallback((state, added) => {
    refetchQuiet();
    if (added > 0 && state.recent?.length) {
      const p = state.recent[0];
      showToast(
        added === 1
          ? `Pick ${p.pick_no}: ${p.name} — ${p.by}`
          : `${added} picks — latest ${p.name} at ${p.pick_no}`,
        'info',
      );
    }
  }, [refetchQuiet, showToast]);

  const {
    draft, connect, disconnect, syncNow, lookup, connecting, error: draftError, setError: setDraftError,
  } = useDraftSync({ onPicks });

  // Storage durability, read once at load.
  const [storage, setStorage] = useState(null);
  useEffect(() => {
    fetch('/api/health')
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (d && d.storage) setStorage(d.storage); })
      .catch(() => {});
  }, []);

  const [modalPlayer, setModalPlayer] = useState(null);
  const [filterBarHeight, setFilterBarHeight] = useState(53);
  const filterBarRef = useRef(null);

  const openModal = useCallback((player) => setModalPlayer(player), []);
  const closeModal = useCallback(() => setModalPlayer(null), []);

  const handleModalUpdate = useCallback((id, changes) => {
    updateOverride(id, changes);
    setModalPlayer(prev => prev && prev.id === id ? { ...prev, ...changes } : prev);
  }, [updateOverride]);

  // Measure FilterBar height so the table sticky header sits precisely below it.
  useEffect(() => {
    if (!filterBarRef.current) return;
    const update = () => {
      const h = filterBarRef.current?.getBoundingClientRect().height ?? 53;
      setFilterBarHeight(Math.ceil(h));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(filterBarRef.current);
    return () => ro.disconnect();
  }, []);

  const seeding = loading && players.length === 0;

  const formatLabel = { BB: 'Best Ball', RD: 'Redraft', DYN: 'Dynasty' }[format] || format;

  return (
    <div className="min-h-screen bg-[#0f1117] text-[#e8eaf0]">
      {/* Top header */}
      <header className="bg-[#0f1117] border-b border-[#1e2132] px-3 sm:px-6 py-2 sm:py-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 sm:gap-3 min-w-0">
          <span className="text-xl sm:text-2xl">🏈</span>
          <div className="min-w-0">
            <h1 className="text-base sm:text-lg font-bold tracking-tight truncate">NFL Draft Cheatsheet</h1>
            <p className="text-[11px] sm:text-xs text-[#555875] truncate">
              0.5 PPR · {formatLabel} · {leagueType} · {teamSize}-team · {new Date().getFullYear()}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-none">
          {/* Silent data loss is the worst kind, so it is said out loud where the board
              is actually looked at, not only in a health endpoint. */}
          {storage && !storage.persistent && (
            <a
              href="https://docs.railway.com/reference/volumes"
              target="_blank"
              rel="noreferrer"
              className="text-xs px-2 py-0.5 rounded border border-amber-500/50 bg-amber-500/10 text-amber-300 whitespace-nowrap"
              title={`This board is running from ${storage.db_path}, inside the container. `
                + 'It is destroyed on the next deploy and your rankings, stars, tiers and notes go '
                + 'with it — the player list re-seeds itself, so nothing will look wrong. '
                + 'Attach a Volume to the Railway service and redeploy to fix it.'}
            >
              ⚠ Not saved
            </a>
          )}
          <span className="text-xs text-[#555875] font-mono whitespace-nowrap">
            {!loading && `${players.length} players`}
          </span>
        </div>
      </header>

      <FilterBar
        ref={filterBarRef}
        filters={filters}
        setFilter={setFilter}
        sourceStatus={sourceStatus}
        refreshing={refreshing}
        onRefresh={refreshSource}
        format={format}
        setFormat={setFormat}
        leagueType={leagueType}
        setLeagueType={setLeagueType}
        view={view}
        excluded={excluded}
        onToggleSource={toggleSource}
        onEnableAllSources={enableAllSources}
        formatLabel={formatLabel}
        tiers={tiers}
        teamSize={teamSize}
        setTeamSize={setTeamSize}
        draft={draft}
        onConnectDraft={connect}
        onDisconnectDraft={disconnect}
        onSyncDraft={syncNow}
        onLookupDrafts={lookup}
        draftConnecting={connecting}
        draftError={draftError}
        onClearDraftError={() => setDraftError(null)}
      />

      {seeding && (
        <div className="flex flex-col items-center justify-center py-24 text-[#8b90a8]">
          <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mb-4" />
          <div className="text-base font-medium">Populating player data…</div>
          <div className="text-sm text-[#555875] mt-1">Fetching from Sleeper API on first run</div>
        </div>
      )}

      {!seeding && (
        <main className="px-2 pb-8">
          <DraftBoard
            players={players}
            loading={loading}
            onUpdate={updateOverride}
            onOpenModal={openModal}
            onReorder={reorderPlayer}
            format={format}
            leagueType={leagueType}
            view={view}
            excluded={excluded}
            sourceStatus={sourceStatus}
            sleeperBaseline={sleeperBaseline}
            xfpReplacement={xfpReplacement}
            filterBarHeight={filterBarHeight}
            draftConnected={draft.connected}
            draftUrl={draft.draft?.url || null}
          />
        </main>
      )}

      {modalPlayer && (
        <PlayerModal
          player={modalPlayer}
          onClose={closeModal}
          onUpdate={handleModalUpdate}
          sourceStatus={sourceStatus}
          format={format}
          leagueType={leagueType}
        />
      )}

      <Toast toast={toast} />
    </div>
  );
}
