import { useState, useEffect, useCallback, useRef } from 'react';

const DEFAULT_FILTERS = {
  positions: [],
  tier: null,
  starred: false,
  hideDrafted: true,
  search: '',
  sort: '',  // empty = server picks the format's own consensus
};

// Sources the user has switched off, by family. One list for the whole app rather than
// one per view: a family covers a market's 1QB and Superflex boards together, so
// flipping Superflex no longer silently re-enables something you turned off.
// null means "not customised" — the server applies its own defaults.

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
  const [excluded, setExcludedRaw] = useState(() => loadLS('draft_excluded_families', null));
  const [teamSize, setTeamSizeRaw] = useState(() => loadLS('draft_team_size', 12));
  const [view, setView] = useState(null);

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
  const fetchPlayers = useCallback(async (
    currentFilters = filters,
    currentLeagueType = leagueType,
    currentFormat = format,
    currentExcluded = undefined,
    currentTeamSize = teamSize,
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

      // Omitting the parameter asks for the server's defaults; sending it — even empty —
      // means the user has made a choice, including "everything on".
      const off = currentExcluded !== undefined ? currentExcluded : excluded;
      if (off !== null) params.set('exclude', off.join(','));
      params.set('teamSize', currentTeamSize);

      const res = await fetch(`/api/players?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setPlayers(data.players || []);
      setView(data.view || null);
      // First load has no stored choice, so adopt whatever the server switched on.
      if (excluded === null && Array.isArray(data.excluded)) setExcludedRaw(data.excluded);
    } catch (err) {
      setError(err.message);
      showToast(`Failed to load players: ${err.message}`, 'error');
    } finally {
      setLoading(false);
    }
  }, [filters, leagueType, format, excluded, teamSize, showToast]);

  const setFormat = useCallback((f) => {
    const nextFilters = { ...filters, sort: '' };
    setFormatRaw(f);
    setFiltersState(nextFilters);
    localStorage.setItem('draft_format', JSON.stringify(f));
    fetchPlayers(nextFilters, leagueType, f);
  }, [fetchPlayers, filters, leagueType]);

  const setLeagueType = useCallback((lt) => {
    const nextFilters = { ...filters, sort: '' };
    setLeagueTypeRaw(lt);
    setFiltersState(nextFilters);
    localStorage.setItem('draft_league_type', JSON.stringify(lt));
    fetchPlayers(nextFilters, lt, format);
  }, [fetchPlayers, filters, format]);

  const applyExcluded = useCallback((next) => {
    setExcludedRaw(next);
    localStorage.setItem('draft_excluded_families', JSON.stringify(next));
    fetchPlayers(filters, leagueType, format, next);
  }, [fetchPlayers, filters, leagueType, format]);

  // Toggling a source changes the consensus, so the board is refetched rather than
  // just re-rendered with a column hidden.
  const toggleSource = useCallback((family) => {
    const current = excluded || [];
    applyExcluded(current.includes(family)
      ? current.filter(c => c !== family)
      : [...current, family]);
  }, [excluded, applyExcluded]);

  const enableAllSources = useCallback(() => applyExcluded([]), [applyExcluded]);

  const setTeamSize = useCallback((size) => {
    setTeamSizeRaw(size);
    localStorage.setItem('draft_team_size', JSON.stringify(size));
    fetchPlayers(filters, leagueType, format, undefined, size);
  }, [fetchPlayers, filters, leagueType, format]);

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
    setPlayers(prev => {
      const next = prev.map(p => (p.id === id ? { ...p, ...changes } : p));
      // Marking a player drafted has to take them off the board straight away — during
      // a live draft that is the whole point of the action, and waiting for the next
      // fetch left them sitting there looking available.
      return next.filter(p => {
        if (filters.hideDrafted && p.drafted) return false;
        if (filters.starred && !p.starred) return false;
        if (filters.tier != null && p.tier !== filters.tier) return false;
        return true;
      });
    });
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
  }, [fetchPlayers, filters, showToast]);

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
    excluded: excluded || [],
    toggleSource,
    enableAllSources,
    teamSize,
    setTeamSize,
  };
}
