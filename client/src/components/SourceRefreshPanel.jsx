import React from 'react';

const SOURCES = ['fantasypros', 'underdog', 'sleeper'];
const LABELS = { fantasypros: 'FantasyPros', underdog: 'Underdog', sleeper: 'Sleeper' };

function StatusDot({ status }) {
  if (status === 'ok') return <span className="w-2 h-2 rounded-full bg-green-500 inline-block" />;
  if (status === 'error') return <span className="w-2 h-2 rounded-full bg-red-500 inline-block" />;
  return <span className="w-2 h-2 rounded-full bg-gray-600 inline-block" />;
}

function Spinner() {
  return (
    <svg className="animate-spin w-3 h-3 text-blue-400" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.37 0 0 5.37 0 12h4z" />
    </svg>
  );
}

function formatAge(isoStr) {
  if (!isoStr) return 'never';
  const d = new Date(isoStr);
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export default function SourceRefreshPanel({ sourceStatus, refreshing, onRefresh }) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      {SOURCES.map(src => {
        const meta = sourceStatus[src] || {};
        const isRefreshing = !!refreshing[src] || !!refreshing.all;
        return (
          <div key={src} className="flex items-center gap-1.5 bg-[#1a1d27] border border-[#2e3148] rounded px-2 py-1">
            {isRefreshing ? <Spinner /> : <StatusDot status={meta.status} />}
            <span className="text-xs text-[#8b90a8]">{LABELS[src]}</span>
            <span
              className="text-xs text-[#555875] cursor-default"
              title={meta.status === 'error' ? `Error — click refresh to retry` : `Last: ${meta.last_fetched || 'never'}`}
            >
              {formatAge(meta.last_fetched)}
            </span>
            {meta.status === 'error' && (
              <span className="text-xs text-red-400" title="Last fetch failed">⚠</span>
            )}
            <button
              onClick={() => onRefresh(src)}
              disabled={isRefreshing}
              className="ml-0.5 text-[#555875] hover:text-blue-400 disabled:opacity-40 transition-colors text-xs"
              title={`Refresh ${LABELS[src]}`}
            >
              ↻
            </button>
          </div>
        );
      })}
      <button
        onClick={() => onRefresh('all')}
        disabled={!!refreshing.all || SOURCES.some(s => refreshing[s])}
        className="btn-ghost text-xs px-2 py-1 disabled:opacity-40"
      >
        {(!!refreshing.all || SOURCES.some(s => refreshing[s])) ? (
          <span className="flex items-center gap-1"><Spinner /> Refreshing...</span>
        ) : (
          'Refresh All'
        )}
      </button>
    </div>
  );
}
