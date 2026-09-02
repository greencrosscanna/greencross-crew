#!/usr/bin/env python3
"""
Reconcile the names in the parsed incentive history against the GX Core employee registry.

    ./tools/match_incentive_names.py --history <history.json> --employees <employees.json> \
                                     [--out matched.json] [--map overrides.json]

WHY A SEPARATE, REVIEWABLE STEP
The PDFs span a year of staff turnover and were typed by hand into a spreadsheet, so they carry
misspellings the registry does not (Nathaniel Schn[ie]der), embedded nicknames (Jennifer "Jayce"
Alexander), and 66 distinct people against a current roster of far fewer -- most of the gap is
simply people who have left. Matching payroll history to the wrong person is not a display bug,
so nothing here writes: it prints a report, and anything ambiguous stays unresolved until a human
says otherwise via --map.

THE LADDER IS CREW'S OWN, PORTED
nameToKey_ / canonFirst_ / ratio_ / nameParts_ / samePerson_ are transcribed from
apps-script/Code.gs rather than reimplemented. Crew's CLAUDE.md is explicit that two detectors
disagreeing about whether somebody is already on the roster is worse than either alone -- it
either hides a real person or proposes a duplicate. tests/incentive_name_match_test.js pins this
port against the same cases the engine's own tests use.
"""
import json, re, sys, unicodedata

NICKNAMES = {'mike': 'michael', 'zach': 'zachary', 'chris': 'christopher', 'sam': 'samuel',
             'jon': 'jonathan', 'nick': 'nicholas', 'dan': 'daniel', 'matt': 'matthew',
             'jen': 'jennifer', 'tanner': 'taner', 'sky': 'skyler', 'skylar': 'skyler',
             'bob': 'robert', 'rob': 'robert', 'tom': 'thomas', 'tj': 'thomas',
             'drew': 'andrew'}

def name_to_key(name):
    s = str(name or '').lower()
    s = re.sub(r'["\'`]', '', s)
    s = s.replace('.', '').strip()
    return re.sub(r'\s+', '_', s)

def canon_first(f):
    x = re.sub(r'[^a-z]', '', str(f or '').lower())
    return NICKNAMES.get(x, x)

def ratio(a, b):
    """Crew's ratio_ verbatim: greedy first-match character overlap, NOT a Levenshtein ratio."""
    if a == b: return 1.0
    if not a or not b: return 0.0
    m, used = 0, {}
    for ch in a:
        for j, cb in enumerate(b):
            if not used.get(j) and ch == cb:
                used[j] = 1; m += 1; break
    return (2.0 * m) / (len(a) + len(b))

def name_parts(full):
    t = str(full or '').strip().split()
    return (t[0] if t else '', t[-1] if len(t) > 1 else '')

def same_person(a_full, b_full):
    af_raw, al_raw = name_parts(a_full)
    bf_raw, bl_raw = name_parts(b_full)
    af, bf = canon_first(af_raw), canon_first(bf_raw)
    al = re.sub(r'[^a-z]', '', al_raw.lower())
    bl = re.sub(r'[^a-z]', '', bl_raw.lower())
    if not al or not bl: return False
    first_ok = (af == bf or af.startswith(bf[:3]) or bf.startswith(af[:3]) or ratio(af, bf) >= 0.8)
    if not first_ok: return False
    return al == bl or bl in al or al in bl or ratio(al, bl) >= 0.85

def strip_quoted_nickname(name):
    """`Jennifer "Jayce" Alexander` -> `Jennifer Alexander`. The sheet embedded the nickname in the
    legal name; the registry keeps them in separate columns, so the quoted part is removed before
    matching and reported separately -- it is a hint that preferred_name may be worth setting."""
    nick = None
    m = re.search(r'["“‘\']([^"”’\']+)["”’\']', name)
    if m: nick = m.group(1).strip()
    cleaned = re.sub(r'["“‘\']([^"”’\']+)["”’\']', ' ', name)
    return ' '.join(cleaned.split()), nick

def main():
    args = dict()
    for i, a in enumerate(sys.argv):
        if a.startswith('--') and i + 1 < len(sys.argv): args[a[2:]] = sys.argv[i + 1]
    hist = json.load(open(args['history']))
    emps = json.load(open(args['employees']))
    emps = emps.get('employees', emps)
    overrides = json.load(open(args['map'])) if args.get('map') else {}

    # Every name the history mentions, with where and how often -- the store and the busiest
    # period make an ambiguous match decidable by a human without opening the PDFs.
    seen = {}
    for p in hist['periods']:
        people = [(r, 'budtender') for r in p['budtenders']] + [(r, 'manager') for r in p['managers']]
        if p.get('admin'): people.append((p['admin'], 'admin'))
        for r, role in people:
            k = r['name'].strip()
            e = seen.setdefault(k, {'name': k, 'roles': set(), 'stores': set(),
                                    'periods': [], 'bonus_total': 0.0})
            e['roles'].add(role); e['stores'].add(r.get('store_label') or '')
            e['periods'].append(p['pp_start']); e['bonus_total'] += (r.get('bonus') or 0)

    # A MERGED record is a tombstone. GX Core keeps it so the old employee_id still resolves for
    # Leaderboard and SPIFF joins, which means it is still returned by getEmployees and still
    # matches on name -- and attaching a year of payout history to it would hang that history off
    # a record nothing renders. Retired is NOT the same thing: a retired person is a real person
    # who worked those periods, and their history belongs to them.
    live = [e for e in emps if str(e.get('status') or '').lower() != 'merged']

    # Match the name the reports actually PRINT. The spreadsheet wrote "Nathan Wydick" and
    # "TJ Peterson"; the registry's legal names are Robert Wydick and Thomas Peterson, with
    # display_name carrying "Nate Wydick" and "TJ Peterson". Keying on full_name alone cannot
    # reach either, and one of them had already gone to a tombstone.
    by_key = {}
    for e in live:
        for field in ('full_name', 'display_name'):
            k = name_to_key(e.get(field))
            if k and k not in by_key:
                by_key[k] = e

    resolved, fuzzy, unmatched = [], [], []

    for name, info in sorted(seen.items()):
        clean, nick = strip_quoted_nickname(name)
        rec = {'pdf_name': name, 'quoted_nickname': nick,
               'stores': sorted(x for x in info['stores'] if x),
               'roles': sorted(info['roles']), 'periods': len(info['periods']),
               'first_period': min(info['periods']), 'last_period': max(info['periods']),
               'bonus_total': round(info['bonus_total'], 2)}

        if name in overrides or clean in overrides:
            rec['employee_id'] = overrides.get(name, overrides.get(clean))
            rec['how'] = 'override'; resolved.append(rec); continue

        exact = by_key.get(name_to_key(clean))
        if exact:
            rec['employee_id'] = exact['employee_id']; rec['registry_name'] = exact.get('full_name')
            rec['how'] = 'exact'; resolved.append(rec); continue

        cands = [e for e in live
                 if same_person(clean, e.get('full_name'))
                 or same_person(clean, e.get('display_name'))]
        if len(cands) == 1:
            rec['employee_id'] = cands[0]['employee_id']
            rec['registry_name'] = cands[0].get('full_name')
            rec['how'] = 'fuzzy'; fuzzy.append(rec)
        elif len(cands) > 1:
            rec['candidates'] = [{'employee_id': c['employee_id'], 'full_name': c.get('full_name')} for c in cands]
            rec['how'] = 'ambiguous'; unmatched.append(rec)
        else:
            rec['how'] = 'none'; unmatched.append(rec)

    print('registry: %d employees (%d live, %d merged tombstones)   history: %d distinct names\n'
          % (len(emps), len(live), len(emps) - len(live), len(seen)))
    print('EXACT   %d' % len(resolved))
    print('FUZZY   %d  (review these -- a wrong one attaches somebody else\'s pay)' % len(fuzzy))
    for r in fuzzy:
        print('   %-28s -> %-28s %s  %dpp  $%.0f' % (
            r['pdf_name'][:28], r.get('registry_name', '')[:28], ','.join(r['stores'])[:18],
            r['periods'], r['bonus_total']))
    print('\nUNMATCHED %d  (mostly people who have left -- they still need a home for their history)'
          % len(unmatched))
    for r in unmatched:
        extra = ''
        if r['how'] == 'ambiguous':
            extra = '  CANDIDATES: ' + ', '.join(c['full_name'] for c in r['candidates'])
        print('   %-28s %-18s %dpp  %s..%s  $%.0f%s' % (
            r['pdf_name'][:28], ','.join(r['stores'])[:18], r['periods'],
            r['first_period'], r['last_period'], r['bonus_total'], extra))

    if args.get('out'):
        json.dump({'resolved': resolved, 'fuzzy': fuzzy, 'unmatched': unmatched},
                  open(args['out'], 'w'), indent=1)
        print('\nwrote ' + args['out'])
    return 0

if __name__ == '__main__':
    sys.exit(main())
