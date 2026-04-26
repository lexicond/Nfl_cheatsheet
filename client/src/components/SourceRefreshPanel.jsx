import React, { useState } from 'react';

// All sources with display metadata
const SOURCE_DEFS = [
  { key: 'fantasypros', label: 'FP', fullLabel: 'FantasyPros', format: ['BB', 'RD'] },
  { key: 'underdog',    label: 'UD', fullLabel: 'Underdog/DS/FFC', format: ['BB'] },
  { key: 'ffc',         label: 'FFC', fullLabel: 'FFC ½PPR', format: ['BB', 'RD'] },
  { key: 'sleeper',     label: 'SL', fullLabel: 'Sleeper', format: ['BB', 'RD', 'DYN'] },
  { key: 'ktc',         label: 'KTC', fullLabel: 'KeepTradeCut', format: ['DYN'] },
  { key: 'fantasycalc', label: 'FC',  fullLabel: 'FantasyCalc', format: ['DYN'] },
];

function StatusDot({ status }) {
  if (status === 'ok') return <span className="w-2 h-2 rounded-full bg-green-500 inline-block flex-shrink-0" />;
  if (status === 'error') return <span className="w-2 h-2 rounded-full bg-red-500 inline-block flex-shrink-0" />;
  return <span className="w-2 h-2 rounded-full bg-gray-600 inline-block flex-shrink-0" />;
}

function Spinner() {
  return (
    <svg className="animate-spin w-3 h-3 text-blue-400 flex-shrink-0" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.37 0 0 5.37 0 12h4z" />
    </svg>
  );
}

function formatAge(isoStr) {
  if (!isoStr) return 'never';
  const diff = Date.now() - new Date(isoStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

export default function SourceRefreshPanel({ sourceStatus, refreshing, onRefresh, enabledSources = {}, onToggleSource }) {
  const [expanded, setExpanded] = useState(false);

  const anyRefreshing = SOURCE_DEFS.some(s => refreshing[s.key]) || !!refreshing.all;

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {/* Collapsed: show compact status badges */}
      {!expanded && SOURCE_DEFS.map(src => {
        const meta = sourceStatus[src.key] || {};
        const isRefreshing = !!refreshing[src.key] || !!refreshing.all;
        const enabled = enabledSources[src.key] !== false;
        return (
          <div
            key={src.key}
            className={`flex items-center gap-1 bg-[#1a1d27] border rounded px-2 py-1 transition-opacity ${
              enabled ? 'border-[#2e3148]' : 'border-[#1e2132] opacity-50'
            }`}
            title={`${src.fullLabel} · ${meta.last_fetched ? new Date(meta.last_fetched).toLocaleString() : 'never fetched'}${meta.notes ? ` · via ${meta.notes}` : ''}`}
          >
            {isRefreshing ? <Spinner /> : <StatusDot status={meta.status} />}
            <span className="text-xs text-[#8b90a8]">{src.label}</span>
            <span className="text-xs text-[#555875]">{formatAge(meta.last_fetched)}</span>
            {meta.status === 'error' && <span className="text-xs text-red-400">⚠</span>}
            <button
              onClick={() => onRefresh(src.key)}
              disabled={isRefreshing}
              className="text-[#555875] hover:text-blue-400 disabled:opacity-40 transition-colors text-xs"
              title={`Refresh ${src.fullLabel}`}
            >
              ↻
            </button>
          </div>
        );
      })}

      {/* Expanded: column visibility toggles */}
      {expanded && SOURCE_DEFS.map(src => {
        const meta = sourceStatus[src.key] || {};
        const isRefreshing = !!refreshing[src.key] || !!refreshing.all;
        const enabled = enabledSources[src.key] !== false;
        return (
          <div
            key={src.key}
            className="flex items-center gap-1.5 bg-[#1a1d27] border border-[#2e3148] rounded px-2 py-1"
          >
            {isRefreshing ? <Spinner /> : <StatusDot status={meta.status} />}
            {/* Column visibility toggle */}
            <button
              onClick={() => onToggleSource?.(src.key)}
              className={`text-xs font-medium transition-colors ${enabled ? 'text-[#e8eaf0]' : 'text-[#555875] line-through'}`}
              title={enabled ? `Hide ${src.fullLabel} column` : `Show ${src.fullLabel} column`}
            >
              {src.fullLabel}
            </button>
            <span className="text-xs text-[#555875]">{formatAge(meta.last_fetched)}</span>
            {meta.status === 'error' && <span className="text-xs text-red-400" title="Last fetch failed">⚠</span>}
            <button
              onClick={() => onRefresh(src.key)}
              disabled={isRefreshing}
              className="text-[#555875] hover:text-blue-400 disabled:opacity-40 transition-colors text-xs"
              title={`Refresh ${src.fullLabel}`}
            >
              ↻
            </button>
          </div>
        );
      })}

      {/* Refresh All */}
      <button
        onClick={() => onRefresh('all')}
        disabled={anyRefreshing}
        className="btn-ghost text-xs px-2 py-1 disabled:opacity-40"
        title="Refresh all sources"
      >
        {anyRefreshing ? (
          <span className="flex items-center gap-1"><Spinner /> Refreshing…</span>
        ) : (
          'Refresh All'
        )}
      </button>

      {/* Toggle expanded/collapsed */}
      <button
        onClick={() => setExpanded(e => !e)}
        className="text-xs text-[#555875] hover:text-[#8b90a8] transition-colors px-1"
        title={expanded ? 'Collapse source panel' : 'Expand to toggle column visibility'}
      >
        {expanded ? '▲' : '▼'}
      </button>
    </div>
  );
}
