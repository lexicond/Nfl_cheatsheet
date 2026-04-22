import { useState, useEffect, useCallback, useRef } from 'react';

const DEFAULT_FILTERS = {
  positions: [],
  tier: null,
  starred: false,
  hideDrafted: true,
  search: '',
  sort: 'adp_consensus',
};

const DEFAULT_ENABLED_SOURCES = {
  fantasypros: true,
  underdog: true,
  ffc: true,
  sleeper: true,
  ktc: true,
  fantasycalc: true,
};

function loadLS(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v != null ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}

export function usePlayers() {
  const [players, setPlayers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filters, setFiltersState] = useState(DEFAULT_FILTERS);
  const [sourceStatus, setSourceStatus] = useState({});
  const [refreshing, setRefreshing] = useState({});
  const [toast, setToast] = useState(null);

  // Format settings — persisted in localStorage
  const [format, setFormatRaw] = useState(() => loadLS('draft_format', 'BB'));
  const [leagueType, setLeagueTypeRaw] = useState(() => loadLS('draft_league_type', '1QB'));
  const [enabledSources, setEnabledSourcesRaw] = useState(() => loadLS('draft_enabled_sources', DEFAULT_ENABLED_SOURCES));

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

  // fetchPlayers must be defined before any hook that lists it as a dependency
  const fetchPlayers = useCallback(async (currentFilters = filters, currentLeagueType = leagueType) => {
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
      params.set('leagueType', currentLeagueType);

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
  }, [filters, leagueType, showToast]);

  const setFormat = useCallback((f) => {
    setFormatRaw(f);
    localStorage.setItem('draft_format', JSON.stringify(f));
  }, []);

  const setLeagueType = useCallback((lt) => {
    setLeagueTypeRaw(lt);
    localStorage.setItem('draft_league_type', JSON.stringify(lt));
    fetchPlayers(filters, lt);
  }, [fetchPlayers, filters]);

  const setEnabledSources = useCallback((es) => {
    setEnabledSourcesRaw(es);
    localStorage.setItem('draft_enabled_sources', JSON.stringify(es));
  }, []);

  useEffect(() => {
    fetchPlayers();
    fetchSourceStatus();
  }, []);

  const setFilter = useCallback((key, value) => {
    setFiltersState(prev => {
      const next = { ...prev, [key]: value };
      if (key === 'search') {
        clearTimeout(searchDebounceRef.current);
        searchDebounceRef.current = setTimeout(() => fetchPlayers(next, leagueType), 300);
      } else {
        fetchPlayers(next, leagueType);
      }
      return next;
    });
  }, [fetchPlayers, leagueType]);

  const updateOverride = useCallback(async (id, changes) => {
    setPlayers(prev => prev.map(p => p.id === id ? { ...p, ...changes } : p));
    try {
      const res = await fetch(`/api/players/${id}/override`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(changes),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      showToast(`Save failed: ${err.message}`, 'error');
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
          const extra = data.actual_source && data.actual_source !== source
            ? ` (via ${data.actual_source})`
            : '';
          showToast(`${source}${extra} refreshed — ${data.players_updated} players`, 'success');
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
    format,
    setFormat,
    leagueType,
    setLeagueType,
    enabledSources,
    setEnabledSources,
  };
}
