import React, { useState, useRef, useEffect } from 'react';

const KIND_STYLE = {
  adp: 'text-green-400 border-green-500/40 bg-green-500/10',
  ecr: 'text-blue-400 border-blue-500/40 bg-blue-500/10',
  value: 'text-purple-400 border-purple-500/40 bg-purple-500/10',
};

function formatAge(isoStr) {
  if (!isoStr) return 'never';
  const mins = Math.floor((Date.now() - new Date(isoStr).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/**
 * Explanation card. Rendered next to the row rather than as a title attribute so it
 * can hold a full sentence, and shown on focus as well as hover so it is reachable
 * from the keyboard.
 */
function Explainer({ source, status }) {
  return (
    <div
      role="tooltip"
      className="absolute right-full top-0 mr-2 w-72 z-50 bg-[#11141d] border border-[#2e3148] rounded-md p-3 shadow-2xl text-left pointer-events-none"
    >
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-sm font-semibold text-[#e8eaf0]">{source.label}</span>
        <span className={`text-[10px] px-1.5 py-0.5 rounded border font-medium ${KIND_STYLE[source.kind] || ''}`}>
          {source.kindLabel}
        </span>
      </div>
      <p className="text-xs text-[#b9c0d4] leading-relaxed m-0">{source.what}</p>
      <div className="mt-2 pt-2 border-t border-[#1e2132] text-[10px] text-[#555875] leading-relaxed">
        <div>Scoring: {source.scoringLabel}</div>
        <div>From: {source.provider}</div>
        {status?.last_fetched && <div>Fetched {formatAge(status.last_fetched)}</div>}
        {source.excludedReason && (
          <div className="text-amber-400/80 mt-1">Not averaged — {source.excludedReason}</div>
        )}
      </div>
    </div>
  );
}

function SourceRow({ source, enabled, onToggle, status, canToggle }) {
  const [hover, setHover] = useState(false);
  const failed = status?.status === 'error';

  return (
    <div
      className="relative flex items-center gap-2 px-2 py-1.5 rounded hover:bg-[#1a1d27] transition-colors"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <input
        type="checkbox"
        id={`src-${source.column}`}
        checked={enabled}
        disabled={!canToggle}
        onChange={() => onToggle(source.column)}
        className="accent-blue-500 cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
      />
      <label
        htmlFor={`src-${source.column}`}
        onFocus={() => setHover(true)}
        onBlur={() => setHover(false)}
        tabIndex={0}
        className={`flex-1 text-xs cursor-pointer select-none ${enabled ? 'text-[#e8eaf0]' : 'text-[#555875]'}`}
      >
        {source.label}
      </label>

      <span className={`text-[9px] px-1 py-0.5 rounded border ${KIND_STYLE[source.kind] || ''}`}>
        {source.kind === 'adp' ? 'ADP' : source.kind === 'ecr' ? 'EXPERT' : 'VALUE'}
      </span>

      {failed && <span className="text-[10px] text-red-400" title="Last fetch failed">⚠</span>}
      <span className="text-[10px] text-[#555875] w-4 text-center" aria-hidden="true">?</span>

      {hover && <Explainer source={source} status={status} />}
    </div>
  );
}

export default function SourcePanel({
  view, excluded = [], onToggleSource, onResetSources,
  sourceStatus = {}, formatLabel, leagueType,
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = e => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    window.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); window.removeEventListener('keydown', onKey); };
  }, [open]);

  if (!view) return null;

  const isExcluded = col => excluded.includes(col);
  const averaged = view.consensus.filter(s => !isExcluded(s.column));
  // Never let the last source be switched off — the board would have nothing to rank by.
  const canToggleOff = averaged.length > 1;

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(o => !o)}
        className="btn-ghost text-xs px-2 py-1 flex items-center gap-1.5"
        aria-expanded={open}
        title="Which sources make up the consensus for this view"
      >
        <span className="text-[#8b90a8]">Sources</span>
        <span className="font-mono text-[#e8eaf0]">{averaged.length}/{view.consensus.length}</span>
        {excluded.length > 0 && <span className="text-amber-400 text-[10px]">edited</span>}
        <span className="text-[#555875]">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 w-80 z-50 bg-[#141821] border border-[#2e3148] rounded-lg shadow-2xl p-3">
          <div className="mb-2">
            <div className="text-xs font-semibold text-[#e8eaf0]">
              {formatLabel} · {leagueType === '2QB' ? 'Superflex' : '1QB'}
            </div>
            <p className="text-[11px] text-[#8b90a8] m-0 mt-0.5 leading-relaxed">
              The Consensus column is the average of the sources ticked below. Hover any
              source to see what it is.
            </p>
          </div>

          <div className="text-[10px] uppercase tracking-wider text-[#555875] mt-3 mb-1">
            Averaged into the consensus
          </div>
          <div className="flex flex-col">
            {view.consensus.map(s => (
              <SourceRow
                key={s.column}
                source={s}
                enabled={!isExcluded(s.column)}
                canToggle={isExcluded(s.column) || canToggleOff}
                onToggle={onToggleSource}
                status={sourceStatus[s.source]}
              />
            ))}
          </div>

          {view.reference.length > 0 && (
            <>
              <div className="text-[10px] uppercase tracking-wider text-[#555875] mt-3 mb-1">
                Shown for reference, not averaged
              </div>
              <div className="flex flex-col">
                {view.reference.map(s => (
                  <SourceRow
                    key={s.column}
                    source={s}
                    enabled={!isExcluded(s.column)}
                    canToggle
                    onToggle={onToggleSource}
                    status={sourceStatus[s.source]}
                  />
                ))}
              </div>
            </>
          )}

          {excluded.length > 0 && (
            <button
              onClick={onResetSources}
              className="btn-ghost text-[11px] px-2 py-1 mt-3 w-full"
            >
              Turn all sources back on
            </button>
          )}
        </div>
      )}
    </div>
  );
}
