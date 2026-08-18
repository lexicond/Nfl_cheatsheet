import React, { useState, useRef, useEffect } from 'react';

const POS_TEXT = {
  QB: 'text-amber-400',
  RB: 'text-green-400',
  WR: 'text-blue-400',
  TE: 'text-orange-400',
};

function staleness(iso) {
  if (!iso) return null;
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 15) return null;             // a normal gap between polls, not worth saying
  if (secs < 90) return `${secs}s ago`;
  return `${Math.floor(secs / 60)}m ago`;
}

const STATUS_LABEL = {
  pre_draft: 'Not started',
  drafting: 'Live',
  paused: 'Paused',
  complete: 'Complete',
};

/** The connect form — draft URL or id, and optionally who you are in it. */
function ConnectForm({ onConnect, onLookup, connecting, error, onClearError }) {
  const [ref, setRef] = useState('');
  const [username, setUsername] = useState(() => {
    try { return localStorage.getItem('sleeper_username') || ''; } catch { return ''; }
  });
  const [found, setFound] = useState(null);
  const [looking, setLooking] = useState(false);

  const submit = (e) => {
    e.preventDefault();
    if (!ref.trim()) return;
    try { localStorage.setItem('sleeper_username', username.trim()); } catch {}
    onConnect(ref.trim(), username.trim());
  };

  const findDrafts = async () => {
    if (!username.trim()) return;
    setLooking(true);
    setFound(null);
    try { localStorage.setItem('sleeper_username', username.trim()); } catch {}
    const data = await onLookup(username.trim());
    setFound(data);
    setLooking(false);
  };

  return (
    <form onSubmit={submit} className="space-y-2">
      <div>
        <label className="block text-xs text-[#8b90a8] mb-1">Sleeper draft link or id</label>
        <input
          type="text"
          value={ref}
          onChange={e => { setRef(e.target.value); onClearError(); }}
          placeholder="sleeper.com/draft/nfl/123…"
          className="input text-xs py-1 w-full"
          autoFocus
        />
      </div>

      <div>
        <label className="block text-xs text-[#8b90a8] mb-1">
          Your Sleeper username <span className="text-[#555875]">— optional, shows your picks and your turn</span>
        </label>
        <div className="flex gap-1">
          <input
            type="text"
            value={username}
            onChange={e => setUsername(e.target.value)}
            placeholder="username"
            className="input text-xs py-1 flex-1"
          />
          <button
            type="button"
            onClick={findDrafts}
            disabled={!username.trim() || looking}
            className="btn-ghost text-xs px-2 py-1 disabled:opacity-40 whitespace-nowrap"
            title="List this season's drafts for that username"
          >
            {looking ? '…' : 'Find drafts'}
          </button>
        </div>
      </div>

      {found && (
        <div className="border border-[#2e3148] rounded p-1.5 max-h-40 overflow-y-auto">
          {found.drafts.length === 0 ? (
            <div className="text-xs text-[#555875] px-1 py-0.5">
              No {found.season} NFL drafts for {found.user.display_name}.
            </div>
          ) : found.drafts.map(d => (
            <button
              key={d.draft_id}
              type="button"
              onClick={() => setRef(d.draft_id)}
              className="w-full text-left text-xs px-1.5 py-1 rounded hover:bg-[#222535] transition-colors"
            >
              <span className={d.status === 'drafting' ? 'text-green-400' : 'text-[#e8eaf0]'}>
                {d.league_name || 'Mock draft'}
              </span>
              <span className="text-[#555875]">
                {' · '}{STATUS_LABEL[d.status] || d.status}
                {d.teams ? ` · ${d.teams}-team` : ''}
                {d.scoring_type ? ` · ${d.scoring_type}` : ''}
              </span>
            </button>
          ))}
        </div>
      )}

      {error && <div className="text-xs text-red-400">{error}</div>}

      <button
        type="submit"
        disabled={!ref.trim() || connecting}
        className="btn-ghost text-xs px-2 py-1 w-full disabled:opacity-40"
      >
        {connecting ? 'Connecting…' : 'Follow this draft'}
      </button>

      <p className="text-xs text-[#555875] leading-relaxed">
        Picks are read from Sleeper's public API every few seconds. Players taken drop off
        the board exactly as if you had ticked them, and come back if you disconnect.
      </p>
    </form>
  );
}

/** Connected view: what the draft is, whose turn it is, and the last picks made. */
function LiveView({ draft, onDisconnect, onSyncNow, onMatchTeamSize, teamSize }) {
  const d = draft.draft || {};
  const stale = staleness(d.last_synced);
  const me = draft.me;

  return (
    <div className="space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs text-[#e8eaf0] font-medium truncate">
            {d.league_name || 'Mock draft'}
          </div>
          <div className="text-xs text-[#555875]">
            {STATUS_LABEL[d.status] || d.status}
            {d.type ? ` · ${d.type}` : ''}
            {d.teams ? ` · ${d.teams}-team` : ''}
            {d.rounds ? ` · ${d.rounds} rds` : ''}
            {d.scoring_type ? ` · ${d.scoring_type}` : ''}
          </div>
        </div>
        <a
          href={d.url}
          target="_blank"
          rel="noreferrer"
          className="text-xs text-[#555875] hover:text-blue-400 whitespace-nowrap"
          title="Open this draft on Sleeper"
        >
          open ↗
        </a>
      </div>

      {/* The draft board's own team count beats the one set by hand. */}
      {d.teams && d.teams !== teamSize && (
        <button
          onClick={() => onMatchTeamSize(d.teams)}
          className="w-full text-xs px-2 py-1 rounded border border-amber-500/40 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20 transition-colors"
        >
          Board is set to {teamSize} teams — match the draft's {d.teams}?
        </button>
      )}

      <div className="flex items-center justify-between text-xs">
        <span className="text-[#8b90a8]">
          <span className="font-mono text-[#e8eaf0]">{draft.picks_made}</span>
          {draft.total_picks ? <span className="text-[#555875]">/{draft.total_picks}</span> : null} picks
        </span>
        {stale
          ? <span className="text-amber-400" title="Last successful sync">⚠ {stale}</span>
          : <span className="text-green-400 flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-green-500 inline-block animate-pulse" />
              live
            </span>}
      </div>

      {d.last_error && (
        <div className="text-xs text-red-400" title="Last poll failed; retrying">
          {d.last_error}
        </div>
      )}

      {draft.on_the_clock && (
        <div className={`text-xs px-2 py-1 rounded border ${
          draft.on_the_clock.is_me
            ? 'border-green-500/50 bg-green-500/15 text-green-300 font-medium'
            : 'border-[#2e3148] text-[#8b90a8]'
        }`}>
          {draft.on_the_clock.is_me ? "You're on the clock" : `On the clock: ${draft.on_the_clock.team}`}
          <span className="text-[#555875]">
            {' · '}pick {draft.on_the_clock.pick_no}
            {draft.on_the_clock.round ? ` (rd ${draft.on_the_clock.round})` : ''}
          </span>
        </div>
      )}

      {me && me.picks_away != null && me.picks_away > 0 && (
        <div className="text-xs text-[#8b90a8]">
          Your next pick: <span className="font-mono text-[#e8eaf0]">#{me.next_pick_no}</span>
          <span className="text-[#555875]"> — {me.picks_away} away</span>
        </div>
      )}

      {draft.complete && (
        <div className="text-xs text-[#555875]">Draft complete — polling stopped.</div>
      )}

      <div>
        <div className="text-xs text-[#555875] mb-1">Latest picks</div>
        {draft.recent.length === 0 ? (
          <div className="text-xs text-[#555875]">No picks yet.</div>
        ) : (
          <div className="max-h-56 overflow-y-auto pr-1 space-y-0.5">
            {draft.recent.map(p => (
              <div
                key={p.pick_no}
                className={`flex items-baseline gap-1.5 text-xs px-1 py-0.5 rounded ${
                  p.is_mine ? 'bg-green-500/10' : ''
                }`}
              >
                <span className="font-mono text-[#555875] w-7 text-right flex-shrink-0">
                  {p.pick_no}
                </span>
                <span className="text-[#e8eaf0] truncate">{p.name || 'Unknown player'}</span>
                {p.position && (
                  <span className={`${POS_TEXT[p.position] || 'text-[#8b90a8]'} flex-shrink-0`}>
                    {p.position}
                  </span>
                )}
                {/* A pick this board does not carry — a kicker, a defence — is marked
                    rather than dropped, so the feed never looks like it missed one. */}
                {!p.matched && (
                  <span className="text-[#555875] flex-shrink-0" title="Not on this board">·</span>
                )}
                <span className="text-[#555875] truncate ml-auto flex-shrink-0">{p.by}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {draft.unmatched > 0 && (
        <div className="text-xs text-[#555875]">
          {draft.unmatched} pick{draft.unmatched === 1 ? '' : 's'} not on this board (kickers,
          defences, players outside the top few hundred).
        </div>
      )}

      <div className="flex gap-1">
        <button onClick={onSyncNow} className="btn-ghost text-xs px-2 py-1 flex-1">
          Sync now
        </button>
        <button
          onClick={onDisconnect}
          className="text-xs px-2 py-1 flex-1 rounded border border-[#2e3148] text-[#8b90a8] hover:border-red-500/40 hover:text-red-400 transition-colors"
          title="Stop following, and put every live pick back on the board"
        >
          Disconnect
        </button>
      </div>
    </div>
  );
}

export default function DraftSyncPanel({
  draft, onConnect, onDisconnect, onSyncNow, onLookup, connecting, error, onClearError,
  teamSize, onMatchTeamSize,
}) {
  const [open, setOpen] = useState(false);
  const panelRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e) => {
      if (panelRef.current && !panelRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const connected = draft.connected;
  const live = connected && !draft.complete;

  return (
    <div className="relative" ref={panelRef}>
      <button
        onClick={() => setOpen(o => !o)}
        className={`flex items-center gap-1.5 text-xs px-2 py-1 rounded border transition-colors ${
          live
            ? 'border-green-500/50 bg-green-500/10 text-green-300'
            : connected
              ? 'border-[#2e3148] text-[#8b90a8]'
              : 'border-[#2e3148] text-[#555875] hover:text-[#8b90a8]'
        }`}
        title={connected ? 'Live Sleeper draft' : 'Follow a live Sleeper draft'}
      >
        {live && <span className="w-1.5 h-1.5 rounded-full bg-green-500 inline-block animate-pulse" />}
        <span>Draft</span>
        {connected
          ? <span className="font-mono">{draft.picks_made}{draft.total_picks ? `/${draft.total_picks}` : ''}</span>
          : <span className="text-[#555875]">off</span>}
      </button>

      {/* Anchored under the button on a desktop. On a phone that put a 320px panel off
          the left edge, so there it becomes a bottom sheet instead — readable, and
          already where a thumb is. */}
      {open && (
        <div className="fixed inset-x-3 bottom-3 max-h-[78vh] overflow-y-auto z-50 bg-[#1a1d27] border border-[#2e3148] rounded-lg shadow-xl p-3
                        sm:absolute sm:inset-x-auto sm:bottom-auto sm:right-0 sm:top-full sm:mt-1 sm:w-80 sm:max-h-none sm:overflow-visible">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-xs font-semibold text-[#e8eaf0]">Live Sleeper draft</h3>
            <button onClick={() => setOpen(false)} className="text-[#555875] hover:text-[#8b90a8] text-xs">✕</button>
          </div>

          {connected ? (
            <LiveView
              draft={draft}
              onDisconnect={onDisconnect}
              onSyncNow={onSyncNow}
              onMatchTeamSize={onMatchTeamSize}
              teamSize={teamSize}
            />
          ) : (
            <ConnectForm
              onConnect={onConnect}
              onLookup={onLookup}
              connecting={connecting}
              error={error}
              onClearError={onClearError}
            />
          )}
        </div>
      )}
    </div>
  );
}
