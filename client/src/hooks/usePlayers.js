import { useState, useEffect, useCallback, useRef } from 'react';

const DEFAULT_FILTERS = {
  positions: [],
  tier: null,
  starred: false,
  hideDrafted: true,
  search: '',
  sort: '',  // empty = server picks the format's own consensus
};

// Columns the user has switched off, by column name. Stored per view, because
// "no ESPN" in redraft says nothing about which dynasty markets you trust.
const DEFAULT_EXCLUDED = {};

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
  const [excludedByView, setExcludedByView] = useState(() => loadLS('draft_excluded_sources', DEFAULT_EXCLUDED));
  const [view, setView] = useState(null);

  const searchDebounceRef = useRef(null);
  const viewKey = `${format}:${leagueType}`;
  const excluded = excludedByView[viewKey] || [];

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
  const fetchPlayers = useCallback(async (
    currentFilters = filters,
    currentLeagueType = leagueType,
    currentFormat = format,
    currentExcluded = null,
  ) => {
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
      params.set('format', currentFormat);

      const off = currentExcluded ?? (excludedByView[`${currentFormat}:${currentLeagueType}`] || []);
      if (off.length > 0) params.set('exclude', off.join(','));

      const res = await fetch(`/api/players?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setPlayers(data.players || []);
      setView(data.view || null);
    } catch (err) {
      setError(err.message);
      showToast(`Failed to load players: ${err.message}`, 'error');
    } finally {
      setLoading(false);
    }
  }, [filters, leagueType, format, excludedByView, showToast]);

  const setFormat = useCallback((f) => {
    const nextFilters = { ...filters, sort: '' };
    setFormatRaw(f);
    setFiltersState(nextFilters);
    localStorage.setItem('draft_format', JSON.stringify(f));
    fetchPlayers(nextFilters, leagueType, f, excludedByView[`${f}:${leagueType}`] || []);
  }, [fetchPlayers, filters, leagueType, excludedByView]);

  const setLeagueType = useCallback((lt) => {
    const nextFilters = { ...filters, sort: '' };
    setLeagueTypeRaw(lt);
    setFiltersState(nextFilters);
    localStorage.setItem('draft_league_type', JSON.stringify(lt));
    fetchPlayers(nextFilters, lt, format, excludedByView[`${format}:${lt}`] || []);
  }, [fetchPlayers, filters, format]);

  // Toggling a source changes the consensus, so the board is refetched rather than
  // just re-rendered with a column hidden.
  const toggleSource = useCallback((column) => {
    const current = excludedByView[viewKey] || [];
    const next = current.includes(column)
      ? current.filter(c => c !== column)
      : [...current, column];
    const merged = { ...excludedByView, [viewKey]: next };
    setExcludedByView(merged);
    localStorage.setItem('draft_excluded_sources', JSON.stringify(merged));
    fetchPlayers(filters, leagueType, format, next);
  }, [excludedByView, viewKey, fetchPlayers, filters, leagueType, format]);

  const resetSources = useCallback(() => {
    const merged = { ...excludedByView, [viewKey]: [] };
    setExcludedByView(merged);
    localStorage.setItem('draft_excluded_sources', JSON.stringify(merged));
    fetchPlayers(filters, leagueType, format, []);
  }, [excludedByView, viewKey, fetchPlayers, filters, leagueType, format]);

  useEffect(() => {
    fetchPlayers();
    fetchSourceStatus();
  }, []);

  // The fetch is kicked off outside the state updater: updaters must stay pure, and
  // React invokes them twice in development, which fired every request twice.
  const setFilter = useCallback((key, value) => {
    const next = { ...filters, [key]: value };
    setFiltersState(next);
    if (key === 'search') {
      clearTimeout(searchDebounceRef.current);
      searchDebounceRef.current = setTimeout(() => fetchPlayers(next, leagueType, format), 300);
    } else {
      fetchPlayers(next, leagueType, format);
    }
  }, [fetchPlayers, filters, leagueType, format]);

  // Drop any pending debounced search when the hook unmounts.
  useEffect(() => () => clearTimeout(searchDebounceRef.current), []);

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
            ? ` — ${data.actual_source}`
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
    view,
    excluded,
    toggleSource,
    resetSources,
  };
}
