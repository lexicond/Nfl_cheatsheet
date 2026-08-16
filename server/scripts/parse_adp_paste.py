#!/usr/bin/env python3
"""
Parse DraftSharks ADP copy-paste into JSON files consumed by seed_adp_paste.js.

Usage:
  1. Copy the two DraftSharks pages into a text file, one after the other:
       https://www.draftsharks.com/adp/best-ball/half-ppr/underdog/12   (Underdog BB)
       https://www.draftsharks.com/adp/half-ppr/sleeper/12              (Sleeper RD)
  2. python3 server/scripts/parse_adp_paste.py <input_file>
     (or pipe: pbpaste | python3 server/scripts/parse_adp_paste.py)

Outputs:
  /tmp/ud_players.json  — Underdog BB ADP
  /tmp/sl_players.json  — Sleeper RD ADP (skill positions only, no DEF/K)
"""
import json
import re
import sys

SKILL_POSITIONS = {'QB', 'RB', 'WR', 'TE'}


def parse_round_pick(s, team_size=12):
    m = re.match(r'^(\d{1,2})\.(\d{1,2})$', s.strip())
    if not m:
        return None
    r, p = int(m.group(1)), int(m.group(2))
    return (r - 1) * team_size + p


def parse_data(text):
    # Join lines split mid-word (e.g. "RB U\nNS" → "RB UNS")
    raw_lines = text.split('\n')
    joined = []
    i = 0
    while i < len(raw_lines):
        ln = raw_lines[i].strip()
        if i + 1 < len(raw_lines):
            nxt = raw_lines[i + 1].strip()
            if re.match(r'^(QB|RB|WR|TE|DEF|K)\s+[A-Z]{1,2}$', ln) and re.match(r'^[A-Z]{1,2}$', nxt):
                joined.append(ln + nxt)
                i += 2
                continue
        joined.append(ln)
        i += 1

    lines = [l for l in joined if l]
    skip_exact = {
        'Show Trend »', 'Player', 'Underdog: Best Ball', 'Sleeper: Redraft',
        '0.5 PPR ADP', 'Market Index', 'KEY Info',
    }
    players = []
    i = 0
    while i < len(lines):
        ln = lines[i]
        if not re.match(r'^\d+$', ln):
            i += 1
            continue
        rank = int(ln)
        i += 1
        if i >= len(lines):
            break
        name = lines[i]; i += 1
        if name in skip_exact:
            continue
        if i >= len(lines):
            break
        pos_team = lines[i]; i += 1
        m = re.match(r'^([A-Z]+)\s+([A-Z]+)$', pos_team)
        if not m:
            continue
        pos, team = m.group(1), m.group(2)
        if i >= len(lines):
            break
        adp_str = lines[i]; i += 1
        adp = parse_round_pick(adp_str)
        if adp is None:
            continue
        # Skip "Show Trend »" and market index (always has explicit + or - sign, or is N/A)
        while i < len(lines) and (
            lines[i] == 'Show Trend »'
            or re.match(r'^[+-]\d+$', lines[i])
            or lines[i] == 'N/A'
        ):
            i += 1
        players.append({'rank': rank, 'name': name, 'position': pos, 'team': team, 'adp': adp})
    return players


def main():
    if len(sys.argv) > 1:
        with open(sys.argv[1]) as f:
            text = f.read()
    else:
        text = sys.stdin.read()

    # Split: Underdog section comes first, Sleeper section starts at "Sleeper: Redraft"
    sl_marker = text.find('Sleeper: Redraft')
    if sl_marker == -1:
        print('ERROR: Could not find "Sleeper: Redraft" marker in input', file=sys.stderr)
        sys.exit(1)

    ud_text = text[:sl_marker]
    sl_text = text[sl_marker:]

    ud_players = parse_data(ud_text)
    sl_players = [p for p in parse_data(sl_text) if p['position'] in SKILL_POSITIONS]

    print(f'Underdog: {len(ud_players)} players')
    print(f'Sleeper: {len(sl_players)} skill players')

    with open('/tmp/ud_players.json', 'w') as f:
        json.dump(ud_players, f)
    with open('/tmp/sl_players.json', 'w') as f:
        json.dump(sl_players, f)

    print('Written: /tmp/ud_players.json, /tmp/sl_players.json')
    print('Now run: node server/scripts/seed_adp_paste.js')


if __name__ == '__main__':
    main()
