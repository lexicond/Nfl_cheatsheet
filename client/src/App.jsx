import React, { useState, useCallback } from 'react';
import { usePlayers } from './hooks/usePlayers';
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
  } = usePlayers();

  const [modalPlayer, setModalPlayer] = useState(null);

  const openModal = useCallback((player) => setModalPlayer(player), []);
  const closeModal = useCallback(() => setModalPlayer(null), []);

  const handleModalUpdate = useCallback((id, changes) => {
    updateOverride(id, changes);
    // Keep modal in sync with local changes
    setModalPlayer(prev => prev && prev.id === id ? { ...prev, ...changes } : prev);
  }, [updateOverride]);

  const seeding = loading && players.length === 0;

  return (
    <div className="min-h-screen bg-[#0f1117] text-[#e8eaf0]">
      {/* Top header */}
      <header className="bg-[#0f1117] border-b border-[#1e2132] px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-2xl">🏈</span>
          <div>
            <h1 className="text-lg font-bold tracking-tight">NFL Draft Cheatsheet</h1>
            <p className="text-xs text-[#555875]">Best Ball · {new Date().getFullYear()}</p>
          </div>
        </div>
        <div className="text-xs text-[#555875] font-mono">
          {!loading && `${players.length} players`}
        </div>
      </header>

      <FilterBar
        filters={filters}
        setFilter={setFilter}
        sourceStatus={sourceStatus}
        refreshing={refreshing}
        onRefresh={refreshSource}
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
          />
        </main>
      )}

      {modalPlayer && (
        <PlayerModal
          player={modalPlayer}
          onClose={closeModal}
          onUpdate={handleModalUpdate}
        />
      )}

      <Toast toast={toast} />
    </div>
  );
}
