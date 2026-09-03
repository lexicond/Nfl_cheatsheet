import React, { forwardRef, useRef, useEffect } from 'react';
import SourceRefreshPanel from './SourceRefreshPanel';
import SourcePanel from './SourcePanel';
import DraftSyncPanel from './DraftSyncPanel';

const POSITIONS = ['QB', 'RB', 'WR', 'TE'];

// The tier buttons used to be a fixed T1–T5, because the tier was a band of ADP rounds
// computed on the server. It is FantasyPros' now and their boards run to sixteen, so the
// buttons come from what this format actually has. 0 is the untiered button — everyone
// past the end of their board, which is where the tier sort puts them.
const UNTIERED = 0;

const SORT_COMMON = [
  { value: 'tier', label: 'Tier' },
  { value: 'personal_rank', label: 'My Rank' },
  { value: 'projected_pts', label: 'Proj Pts' },
];

// Sort options are built from the sources currently switched on, so the dropdown never
// offers a column the board is not showing.
function getSortOptions(view, excluded, format) {
  const consensus = { value: 'adp_consensus', label: format === 'DYN' ? 'Dynasty Rank' : 'Consensus' };
  if (!view) return [consensus, ...SORT_COMMON];

  const active = [...view.consensus, ...view.reference].filter(s => !excluded.includes(s.family));
  return [
    consensus,
    ...active.map(s => ({ value: s.column, label: s.label })),
    { value: 'sleeper_gap_pct', label: 'Cheapest on Sleeper (%)' },
    { value: 'spread', label: 'Most disagreement' },
    // The model's own orderings. Only offered where they mean something: dynasty is a
    // keep-forever league and this is a one-season projection.
    ...(format !== 'DYN' && !excluded.includes('expectedpoints') ? [
      { value: 'xfp_vor', label: 'Value over replacement' },
      { value: 'xfp_edge', label: 'Biggest edge vs market' },
      { value: 'xfp_ceiling', label: 'Highest ceiling' },
      { value: 'xfp_points', label: 'Expected points' },
      { value: 'xfp_ppg', label: 'Points per game' },
    ] : []),
    ...(format === 'DYN' ? [{ value: 'age', label: 'Age (youngest)' }] : []),
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

const TEAM_SIZES = [8, 10, 12, 14];

// Position scarcity context for best ball 3WR format
const SCARCITY = {
  WR: { format: 'BB', label: '3 starters · depth premium' },
  QB: { format: 'BB', label: '1 starter · stream-friendly' },
  RB: { format: 'BB', label: '2 starters · handcuff value' },
  TE: { format: 'BB', label: '1 starter · streaming ok' },
};

const FilterBar = forwardRef(function FilterBar(
  { filters, setFilter, sourceStatus, refreshing, onRefresh, format, setFormat,
    leagueType, setLeagueType, view, excluded, onToggleSource, onEnableAllSources,
    formatLabel, tiers, teamSize, setTeamSize,
    draft, onConnectDraft, onDisconnectDraft, onSyncDraft, onLookupDrafts,
    draftConnecting, draftError, onClearDraftError },
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

  // Scarcity hint: show when exactly one position is selected
  const singlePos = filters.positions.length === 1 ? filters.positions[0] : null;
  const scarcity = singlePos && SCARCITY[singlePos] && SCARCITY[singlePos].format === format
    ? SCARCITY[singlePos].label
    : null;

  // The bar sticks on a desktop but scrolls away on a phone, where it would otherwise
  // hold a third of the screen for the whole draft. backdrop-blur only applies at that
  // desktop breakpoint too: it establishes a containing block, which traps the panels'
  // fixed positioning inside this bar, and on a phone that let a tall panel run off the
  // top of the screen.
  return (
    <div ref={ref} className="relative sm:sticky sm:top-0 z-30 bg-[#0f1117]/95 sm:backdrop-blur border-b border-[#1e2132] px-3 sm:px-4 py-2">
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

        <div className="hidden sm:block w-px h-5 bg-[#2e3148]" />

        {/* Tier filter.

            The pills are desktop-only. FantasyPros' boards carry sixteen tiers, and
            sixteen pills plus ALL and T– is a 710px row that cannot wrap — which does
            not merely look cramped on a phone, it widens the whole DOCUMENT past the
            viewport. Safari then lays the page out at that width without scaling it
            down, so half the board sits off the right of the screen and the rest of the
            app renders into a 54%-wide column with black beside it. `flex-wrap` is here
            for the same reason: it drops the row's min-content width to one pill, so
            this control can never set the page width again. A phone gets the select
            instead — sixteen wrapped pills would eat three rows of a sticky bar that is
            already holding a third of the screen. */}
        <div className="flex flex-wrap items-center gap-1">
          <span className="hidden sm:inline text-xs text-[#555875] mr-0.5">Tier:</span>
          <select
            value={filters.tier ?? ''}
            onChange={e => setFilter('tier', e.target.value === '' ? null : Number(e.target.value))}
            className="sm:hidden input text-xs py-1 pr-6"
            aria-label="Filter by tier"
          >
            <option value="">All tiers</option>
            {(tiers?.present || []).map(t => (
              <option key={t} value={t}>Tier {t}</option>
            ))}
            {tiers?.untiered > 0 && (
              <option value={UNTIERED}>Untiered ({tiers.untiered})</option>
            )}
          </select>
          <button
            onClick={() => setFilter('tier', null)}
            className={`hidden sm:block text-xs px-2 py-1 rounded border font-medium transition-colors ${
              filters.tier == null
                ? 'bg-white/10 border-white/30 text-white'
                : 'border-[#2e3148] text-[#555875] hover:text-[#8b90a8]'
            }`}
          >
            ALL
          </button>
          {(tiers?.present || []).map(t => (
            <button
              key={t}
              onClick={() => toggleTier(t)}
              className={`hidden sm:block text-xs px-2 py-1 rounded border font-bold transition-colors tier-badge ${
                filters.tier === t ? `tier-${t}` : 'border-[#2e3148] text-[#555875] hover:text-[#8b90a8]'
              }`}
            >
              T{t}
            </button>
          ))}
          {tiers?.untiered > 0 && (
            <button
              onClick={() => toggleTier(UNTIERED)}
              title={`${tiers.untiered} players past the end of FantasyPros' board for this format`}
              className={`hidden sm:block text-xs px-2 py-1 rounded border font-bold transition-colors tier-badge border-dashed ${
                filters.tier === UNTIERED
                  ? 'tier-none' : 'border-[#2e3148] text-[#555875] hover:text-[#8b90a8]'
              }`}
            >
              T–
            </button>
          )}
        </div>

        <div className="hidden sm:block w-px h-5 bg-[#2e3148]" />

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

        <div className="hidden sm:block w-px h-5 bg-[#2e3148]" />

        {/* Sort */}
        <select
          value={filters.sort}
          onChange={e => setFilter('sort', e.target.value)}
          className="input text-xs py-1 pr-6"
        >
          <option value="">Default</option>
          {getSortOptions(view, excluded, format).map(o => (
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

        {/* Which sources feed this view, and refresh controls — pushed right */}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <DraftSyncPanel
            draft={draft}
            onConnect={onConnectDraft}
            onDisconnect={onDisconnectDraft}
            onSyncNow={onSyncDraft}
            onLookup={onLookupDrafts}
            connecting={draftConnecting}
            error={draftError}
            onClearError={onClearDraftError}
            teamSize={teamSize}
            onMatchTeamSize={setTeamSize}
          />
          <SourcePanel
            view={view}
            excluded={excluded}
            onToggleSource={onToggleSource}
            onEnableAllSources={onEnableAllSources}
            sourceStatus={sourceStatus}
            formatLabel={formatLabel}
            leagueType={leagueType}
          />
          <SourceRefreshPanel
            sourceStatus={sourceStatus}
            refreshing={refreshing}
            onRefresh={onRefresh}
          />
        </div>
      </div>

      {/* Row 2: Format + League type switcher */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 mt-1.5">
        <span className="hidden sm:inline text-xs text-[#555875]">Format:</span>
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

        <div className="hidden sm:block w-px h-4 bg-[#2e3148]" />

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

        <div className="hidden sm:block w-px h-4 bg-[#2e3148]" />

        <span className="hidden sm:inline text-xs text-[#555875]">Teams:</span>
        <div className="flex items-center gap-1">
          {TEAM_SIZES.map(n => (
            <button
              key={n}
              onClick={() => setTeamSize(n)}
              className={`text-xs px-2 py-0.5 rounded border transition-colors font-medium ${
                teamSize === n
                  ? 'bg-green-500/20 border-green-500/50 text-green-300'
                  : 'border-[#2e3148] text-[#555875] hover:text-[#8b90a8]'
              }`}
              title={`${n}-team league — sets round boundaries and tier bands`}
            >
              {n}
            </button>
          ))}
        </div>

        <span className="hidden sm:inline text-xs text-[#555875] ml-1">· always 0.5 PPR</span>
      </div>
    </div>
  );
});

export default FilterBar;
