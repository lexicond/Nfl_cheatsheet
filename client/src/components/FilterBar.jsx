import React from 'react';
import SourceRefreshPanel from './SourceRefreshPanel';

const POSITIONS = ['QB', 'RB', 'WR', 'TE'];
const TIERS = [1, 2, 3, 4, 5];
const SORT_OPTIONS = [
  { value: 'adp_consensus', label: 'Consensus ADP' },
  { value: 'personal_rank', label: 'My Rank' },
  { value: 'adp_underdog', label: 'Underdog ADP' },
  { value: 'adp_fantasypros', label: 'FantasyPros ADP' },
  { value: 'adp_sleeper', label: 'Sleeper ADP' },
];

const POS_COLORS = {
  QB: 'border-amber-500/50 text-amber-400 bg-amber-500/10',
  RB: 'border-green-500/50 text-green-400 bg-green-500/10',
  WR: 'border-blue-500/50 text-blue-400 bg-blue-500/10',
  TE: 'border-orange-500/50 text-orange-400 bg-orange-500/10',
};

export default function FilterBar({ filters, setFilter, sourceStatus, refreshing, onRefresh }) {
  const togglePosition = (pos) => {
    const current = filters.positions;
    const next = current.includes(pos)
      ? current.filter(p => p !== pos)
      : [...current, pos];
    setFilter('positions', next);
  };

  const toggleTier = (t) => {
    setFilter('tier', filters.tier === t ? null : t);
  };

  return (
    <div className="sticky top-0 z-30 bg-[#0f1117]/95 backdrop-blur border-b border-[#1e2132] px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
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
          ⭐ Starred Only
        </label>

        <div className="w-px h-5 bg-[#2e3148]" />

        {/* Sort */}
        <select
          value={filters.sort}
          onChange={e => setFilter('sort', e.target.value)}
          className="input text-xs py-1 pr-6"
        >
          {SORT_OPTIONS.map(o => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>

        {/* Search */}
        <input
          type="text"
          placeholder="Search player..."
          value={filters.search}
          onChange={e => setFilter('search', e.target.value)}
          className="input text-xs py-1 w-36"
        />

        {/* Source refresh panel — pushed right */}
        <div className="ml-auto">
          <SourceRefreshPanel
            sourceStatus={sourceStatus}
            refreshing={refreshing}
            onRefresh={onRefresh}
          />
        </div>
      </div>
    </div>
  );
}
