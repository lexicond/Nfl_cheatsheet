import { useState, useEffect, useCallback, useRef } from 'react';

const DEFAULT_FILTERS = {
  positions: [],     // [] = all
  tier: null,
  starred: false,
  hideDrafted: true,
  search: '',
  sort: 'adp_consensus',
};

export function usePlayers() {
  const [players, setPlayers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filters, setFiltersState] = useState(DEFAULT_FILTERS);
  const [sourceStatus, setSourceStatus] = useState({});
  const [refreshing, setRefreshing] = useState({});
  const [toast, setToast] = useState(null);
  const searchDebounceRef = useRef(null);

  const showToast = useCallback((message, type = 'info') => {
    setToast({ message, type, id: Date.now() });
    setTimeout(() => setToast(null), 3500);
  }, []);

  const fetchSourceStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/source-status');
      if (res.ok) setSourceStatus(await res.json());
    } catch {}
  }, []);

  const fetchPlayers = useCallback(async (currentFilters = filters) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (currentFilters.positions.length > 0) params.set('position', currentFilters.positions.join(','));
      if (currentFilters.tier) params.set('tier', currentFilters.tier);
      if (currentFilters.starred) params.set('starred', '1');
      if (!currentFilters.hideDrafted) params.set('drafted', '1');
      if (currentFilters.search) params.set('search', currentFilters.search);
      if (currentFilters.sort) params.set('sort', currentFilters.sort);

      const res = await fetch(`/api/players?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setPlayers(data);
    } catch (err) {
      setError(err.message);
      showToast(`Failed to load players: ${err.message}`, 'error');
    } finally {
      setLoading(false);
    }
  }, [filters, showToast]);

  useEffect(() => {
    fetchPlayers();
    fetchSourceStatus();
  }, []);

  const setFilter = useCallback((key, value) => {
    setFiltersState(prev => {
      const next = { ...prev, [key]: value };
      if (key === 'search') {
        // Debounce search
        clearTimeout(searchDebounceRef.current);
        searchDebounceRef.current = setTimeout(() => fetchPlayers(next), 300);
      } else {
        fetchPlayers(next);
      }
      return next;
    });
  }, [fetchPlayers]);

  const updateOverride = useCallback(async (id, changes) => {
    // Optimistic update
    setPlayers(prev => prev.map(p =>
      p.id === id ? { ...p, ...changes } : p
    ));

    try {
      const res = await fetch(`/api/players/${id}/override`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(changes),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      showToast(`Save failed: ${err.message}`, 'error');
      // Revert optimistic update on failure
      fetchPlayers();
    }
  }, [fetchPlayers, showToast]);

  const refreshSource = useCallback(async (source) => {
    setRefreshing(prev => ({ ...prev, [source]: true }));
    try {
      const res = await fetch(`/api/refresh/${source}`, { method: 'POST' });
      const data = await res.json();

      if (source === 'all') {
        const results = data.results || {};
        const failed = Object.entries(results).filter(([, v]) => !v.success).map(([k]) => k);
        if (failed.length > 0) {
          showToast(`Refresh partial — failed: ${failed.join(', ')}`, 'warning');
        } else {
          showToast('All sources refreshed successfully', 'success');
        }
      } else {
        if (data.success) {
          showToast(`${source} refreshed — ${data.players_updated} players`, 'success');
        } else {
          showToast(`${source} refresh failed: ${data.error}`, 'error');
        }
      }

      await fetchSourceStatus();
      await fetchPlayers();
    } catch (err) {
      showToast(`Refresh error: ${err.message}`, 'error');
    } finally {
      setRefreshing(prev => ({ ...prev, [source]: false }));
    }
  }, [fetchPlayers, fetchSourceStatus, showToast]);

  const reorderPlayer = useCallback(async (id, newRank) => {
    try {
      const res = await fetch(`/api/players/${id}/reorder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ personal_rank: newRank }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await fetchPlayers();
    } catch (err) {
      showToast(`Reorder failed: ${err.message}`, 'error');
    }
  }, [fetchPlayers, showToast]);

  return {
    players,
    loading,
    error,
    filters,
    setFilter,
    refetch: fetchPlayers,
    updateOverride,
    refreshSource,
    reorderPlayer,
    sourceStatus,
    refreshing,
    toast,
    showToast,
  };
}
