import { useState, useEffect, useCallback, useRef } from 'react';

// Sleeper has no push channel for drafts, so the picks are polled. Five seconds is
// under a pick timer's resolution and nowhere near Sleeper's 1000-calls-a-minute
// ceiling; the server throttles further so extra tabs cost nothing.
const POLL_MS = 5000;

export function useDraftSync({ onPicks } = {}) {
  const [state, setState] = useState({ connected: false });
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState(null);

  // Held in a ref as well as state so the polling loop can compare against the last
  // count without being torn down and rebuilt on every tick.
  const pickCountRef = useRef(null);
  const onPicksRef = useRef(onPicks);
  onPicksRef.current = onPicks;

  const apply = useCallback((data) => {
    setState(data);
    const before = pickCountRef.current;
    const now = data.connected ? data.picks_made : null;
    pickCountRef.current = now;
    // Only tell the board to reload when the pick count actually moved. Polling every
    // five seconds through a three-hour draft would otherwise refetch a few thousand
    // rows a couple of thousand times for nothing.
    if (now != null && before != null && now !== before) {
      onPicksRef.current?.(data, now - before);
    }
  }, []);

  const poll = useCallback(async () => {
    try {
      const res = await fetch('/api/draft/state');
      if (!res.ok) return;
      apply(await res.json());
    } catch {
      // A dropped poll is not worth surfacing: the next one is five seconds away, and
      // the panel already shows how stale the last successful sync is.
    }
  }, [apply]);

  // Rejoin whatever draft the server is following — a reload mid-draft should not
  // mean typing the draft id in again.
  useEffect(() => {
    fetch('/api/draft/state?sync=0')
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (d) apply(d); })
      .catch(() => {});
  }, [apply]);

  const live = state.connected && !state.complete;

  useEffect(() => {
    if (!live) return;
    const id = setInterval(poll, POLL_MS);
    return () => clearInterval(id);
  }, [live, poll]);

  const connect = useCallback(async (ref, username) => {
    setConnecting(true);
    setError(null);
    try {
      const res = await fetch('/api/draft/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref, username: username || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      // Connecting always redraws the board: the draft may already be well underway.
      pickCountRef.current = data.picks_made;
      setState(data);
      onPicksRef.current?.(data, data.picks_made);
      return data;
    } catch (err) {
      setError(err.message);
      return null;
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    try {
      await fetch('/api/draft/disconnect', { method: 'POST' });
    } catch {}
    pickCountRef.current = null;
    setState({ connected: false });
    setError(null);
    // Every live pick has just gone back onto the board.
    onPicksRef.current?.({ connected: false }, 0);
  }, []);

  const syncNow = useCallback(async () => {
    try {
      const res = await fetch('/api/draft/sync', { method: 'POST' });
      if (res.ok) apply(await res.json());
    } catch {}
  }, [apply]);

  const lookup = useCallback(async (username) => {
    setError(null);
    try {
      const res = await fetch(`/api/draft/lookup?username=${encodeURIComponent(username)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      return data;
    } catch (err) {
      setError(err.message);
      return null;
    }
  }, []);

  return { draft: state, connect, disconnect, syncNow, lookup, connecting, error, setError };
}
