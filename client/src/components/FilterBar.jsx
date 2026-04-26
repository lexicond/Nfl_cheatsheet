import React, { forwardRef, useRef, useEffect } from 'react';
import SourceRefreshPanel from './SourceRefreshPanel';

const POSITIONS = ['QB', 'RB', 'WR', 'TE'];
const TIERS = [1, 2, 3, 4, 5];

const SORT_COMMON = [
  { value: 'personal_rank', label: 'My Rank' },
  { value: 'projected_pts', label: 'Proj Pts' },
];

function getSortOptions(format, leagueType) {
  if (format === 'DYN') return [
    { value: 'ktc_value', label: 'KTC Value' },
    { value: 'fc_value', label: 'FC Value' },
    ...SORT_COMMON,
  ];
  if (format === 'BB' && leagueType === '1QB') return [
    { value: 'adp_sl_bb', label: 'Sleeper ADP' },
    { value: 'adp_consensus', label: 'Consensus' },
    { value: 'adp_fantasypros', label: 'FantasyPros' },
    { value: 'adp_underdog', label: 'Underdog' },
    ...SORT_COMMON,
  ];
  if (format === 'BB') return [ // SF/2QB
    { value: 'adp_sl_sf', label: 'Sleeper SF' },
    { value: 'adp_consensus', label: 'Consensus' },
    { value: 'adp_fp_sf', label: 'FantasyPros SF' },
    { value: 'adp_underdog', label: 'Underdog' },
    ...SORT_COMMON,
  ];
  if (format === 'RD' && leagueType === '1QB') return [
    { value: 'adp_sl_rd', label: 'Sleeper ADP' },
    { value: 'adp_consensus', label: 'Consensus' },
    { value: 'adp_fp_rd', label: 'FantasyPros' },
    { value: 'adp_ffc', label: 'FFC ADP' },
    ...SORT_COMMON,
  ];
  return [ // RD SF/2QB
    { value: 'adp_sl_sf', label: 'Sleeper SF' },
    { value: 'adp_consensus', label: 'Consensus' },
    { value: 'adp_fp_sf', label: 'FantasyPros SF' },
    ...SORT_COMMON,
  ];
}

const POS_COLORS = {
  QB: 'border-amber-500/50 text-amber-400 bg-amber-500/10',
  RB: 'border-green-500/50 text-green-400 bg-green-500/10',
  WR: 'border-blue-500/50 text-blue-400 bg-blue-500/10',
  TE: 'border-orange-500/50 text-orange-400 bg-orange-500/10',
};

const FORMATS = [
  { value: 'BB', label: 'Best Ball' },
  { value: 'RD', label: 'Redraft' },
  { value: 'DYN', label: 'Dynasty' },
];

const LEAGUE_TYPES = [
  { value: '1QB', label: '1QB' },
  { value: '2QB', label: 'SF/2QB' },
];

// Position scarcity context for best ball 3WR format
const SCARCITY = {
  WR: { format: 'BB', label: '3 starters · depth premium' },
  QB: { format: 'BB', label: '1 starter · stream-friendly' },
  RB: { format: 'BB', label: '2 starters · handcuff value' },
  TE: { format: 'BB', label: '1 starter · streaming ok' },
};

const FilterBar = forwardRef(function FilterBar(
  { filters, setFilter, sourceStatus, refreshing, onRefresh, format, setFormat, leagueType, setLeagueType, enabledSources, setEnabledSources },
  ref
) {
  const searchRef = useRef(null);

  // Press "/" to focus search
  useEffect(() => {
    const handler = (e) => {
      if (e.key === '/' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const togglePosition = (pos) => {
    const current = filters.positions;
    const next = current.includes(pos) ? current.filter(p => p !== pos) : [...current, pos];
    setFilter('positions', next);
  };

  const toggleTier = (t) => setFilter('tier', filters.tier === t ? null : t);

  const toggleSource = (src) => {
    setEnabledSources({ ...enabledSources, [src]: !enabledSources[src] });
  };

  // Scarcity hint: show when exactly one position is selected
  const singlePos = filters.positions.length === 1 ? filters.positions[0] : null;
  const scarcity = singlePos && SCARCITY[singlePos] && SCARCITY[singlePos].format === format
    ? SCARCITY[singlePos].label
    : null;

  return (
    <div ref={ref} className="sticky top-0 z-30 bg-[#0f1117]/95 backdrop-blur border-b border-[#1e2132] px-4 py-2">
      {/* Row 1: positions, tiers, toggles, sort, search, sources */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Position pills */}
        <div className="flex items-center gap-1">
          <button
            onClick={() => setFilter('positions', [])}
            className={`text-xs px-2.5 py-1 rounded border font-medium transition-colors ${
              filters.positions.length === 0
                ? 'bg-white/10 border-white/30 text-white'
                : 'border-[#2e3148] text-[#555875] hover:text-[#8b90a8]'
            }`}
          >
            ALL
          </button>
          {POSITIONS.map(pos => (
            <button
              key={pos}
              onClick={() => togglePosition(pos)}
              className={`text-xs px-2.5 py-1 rounded border font-bold transition-colors ${
                filters.positions.includes(pos)
                  ? POS_COLORS[pos]
                  : 'border-[#2e3148] text-[#555875] hover:text-[#8b90a8]'
              }`}
            >
              {pos}
            </button>
          ))}
          {scarcity && (
            <span className="text-xs text-[#555875] italic ml-1">{scarcity}</span>
          )}
        </div>

        <div className="w-px h-5 bg-[#2e3148]" />

        {/* Tier filter */}
        <div className="flex items-center gap-1">
          <span className="text-xs text-[#555875] mr-0.5">Tier:</span>
          <button
            onClick={() => setFilter('tier', null)}
            className={`text-xs px-2 py-1 rounded border font-medium transition-colors ${
              !filters.tier
                ? 'bg-white/10 border-white/30 text-white'
                : 'border-[#2e3148] text-[#555875] hover:text-[#8b90a8]'
            }`}
          >
            ALL
          </button>
          {TIERS.map(t => (
            <button
              key={t}
              onClick={() => toggleTier(t)}
              className={`text-xs px-2 py-1 rounded border font-bold transition-colors tier-badge ${
                filters.tier === t ? `tier-${t}` : 'border-[#2e3148] text-[#555875] hover:text-[#8b90a8]'
              }`}
            >
              T{t}
            </button>
          ))}
        </div>

        <div className="w-px h-5 bg-[#2e3148]" />

        {/* Toggles */}
        <label className="flex items-center gap-1.5 cursor-pointer text-xs text-[#8b90a8]">
          <input
            type="checkbox"
            checked={filters.hideDrafted}
            onChange={e => setFilter('hideDrafted', e.target.checked)}
            className="accent-blue-500 cursor-pointer"
          />
          Hide Drafted
        </label>
        <label className="flex items-center gap-1.5 cursor-pointer text-xs text-[#8b90a8]">
          <input
            type="checkbox"
            checked={filters.starred}
            onChange={e => setFilter('starred', e.target.checked)}
            className="accent-amber-500 cursor-pointer"
          />
          ⭐ Starred
        </label>

        <div className="w-px h-5 bg-[#2e3148]" />

        {/* Sort */}
        <select
          value={filters.sort}
          onChange={e => setFilter('sort', e.target.value)}
          className="input text-xs py-1 pr-6"
        >
          <option value="">Default</option>
          {getSortOptions(format, leagueType).map(o => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>

        {/* Search — press / to focus */}
        <input
          ref={searchRef}
          type="text"
          placeholder="Search… (/)"
          value={filters.search}
          onChange={e => setFilter('search', e.target.value)}
          className="input text-xs py-1 w-32"
        />

        {/* Source refresh panel — pushed right */}
        <div className="ml-auto">
          <SourceRefreshPanel
            sourceStatus={sourceStatus}
            refreshing={refreshing}
            onRefresh={onRefresh}
            enabledSources={enabledSources}
            onToggleSource={toggleSource}
          />
        </div>
      </div>

      {/* Row 2: Format + League type switcher */}
      <div className="flex items-center gap-2 mt-1.5">
        <span className="text-xs text-[#555875]">Format:</span>
        <div className="flex items-center gap-1">
          {FORMATS.map(f => (
            <button
              key={f.value}
              onClick={() => setFormat(f.value)}
              className={`text-xs px-2 py-0.5 rounded border transition-colors font-medium ${
                format === f.value
                  ? 'bg-blue-500/20 border-blue-500/50 text-blue-300'
                  : 'border-[#2e3148] text-[#555875] hover:text-[#8b90a8]'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        <div className="w-px h-4 bg-[#2e3148]" />

        <div className="flex items-center gap-1">
          {LEAGUE_TYPES.map(lt => (
            <button
              key={lt.value}
              onClick={() => setLeagueType(lt.value)}
              className={`text-xs px-2 py-0.5 rounded border transition-colors font-medium ${
                leagueType === lt.value
                  ? 'bg-purple-500/20 border-purple-500/50 text-purple-300'
                  : 'border-[#2e3148] text-[#555875] hover:text-[#8b90a8]'
              }`}
            >
              {lt.label}
            </button>
          ))}
        </div>

        <span className="text-xs text-[#555875] ml-1">· always 0.5 PPR</span>
      </div>
    </div>
  );
});

export default FilterBar;
