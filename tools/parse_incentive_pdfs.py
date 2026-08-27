#!/usr/bin/env python3
"""
Parse the historical "Incentive Dashboard" payout PDFs into structured JSON.

    ./tools/parse_incentive_pdfs.py [--dir <folder>] [--out <file.json>]

WHY THIS IS A ONE-TIME LOCAL TOOL AND NOT AN ENGINE ROUTE
These 27 PDFs are a closed set: one per pay period from 2025-08-04 to 2026-08-16, after which
GX Crew is the record. Apps Script has no PDF text extraction (the Drive PDF->Doc conversion
mangles the column layout this parser depends on), and a parser that runs once and then rots
inside the engine is worse than a documented tool kept beside its output. Run it, review the
JSON, post that to the engine's incentive_import route.

WHAT THE PDFs ARE
Exports of the original "Green Cross Incentive Program" spreadsheet, which is what the
Leaderboard dashboard was ported FROM. They are the record of what was actually PAID, and Sky
has confirmed them final for bonus calculations. They are imported, never recomputed:
benchmarks have already changed once and will again, so recomputing history would silently
restate what people were paid.

*** THE PDFs DO NOT MEASURE THE SAME DISCOUNT THE APP DOES. ***
The spreadsheet's DISCOUNT column is GROSS discount, measured against a ~2.75% manager bar
(the tier legend is printed inside each PDF). Leaderboard measures BUDTENDER-CONTROLLED
DISCRETIONARY discount -- loyalty redemptions and automatic promos excluded -- against 1.5%.
Same staff, same fortnight, 7.30% here and 2.81% there. That recalibration happened when the
sheet became the app. So these rows are NOT a penny-match corpus for the ported math: run the
app's formulas over these inputs and they will disagree, correctly. Import them as history and
verify the port against Leaderboard's own functions instead.

PARSING
`pdftotext -layout` preserves columns, but column WIDTHS vary within a single file (the sheet's
own row heights), so nothing can key off character positions. Every row is therefore parsed from
the RIGHT: the trailing money/percent/dash tokens come in a fixed order, and whatever text
remains on the left is NAME + STORE, split by matching a known store name off the end.

Each PDF states its own totals ("Total Manager Bonuses Awarded", "Total Budtender Bonuses
Awarded"). Those are checked against the sum of the parsed rows, which is what makes a silent
mis-parse loud -- a dropped row or a column read one place over will not balance.
"""
import re, os, sys, json, glob, subprocess, datetime

DEFAULT_DIR = ("/Users/skypinnick/Library/CloudStorage/GoogleDrive-sky@greencrosscanna.com/"
               "My Drive/HR/Incentive Program/Incentive Program Payout Reports")

# Store labels as the SPREADSHEET wrote them. Several no longer exist under these names; the
# mapping to today's store_ids is deliberately NOT done here -- this tool records what the
# document said, and reconciliation is a reviewable step of its own.
STORES = ['Portland Road', 'Center St', 'River Rd', 'Commercial', 'Hillsboro', 'Baseline',
          'Bend', 'Center', 'Portland', 'Division', 'Beaverton']

MONEY = re.compile(r'\(\$\s*(-|[\d,]+\.?\d*)\s*\)')      # ($ 1,234.56) or ($ - )
BARE  = re.compile(r'^\$?(-|[\d,]+\.?\d*)%?$')

def num(tok):
    """A dash means zero -- the sheet prints '-' for nothing rather than 0.00."""
    if tok is None: return None
    t = str(tok).strip().replace('$', '').replace(',', '').replace('%', '').replace('(', '').replace(')', '')
    if t in ('-', '', '—'): return 0.0
    try: return float(t)
    except ValueError: return None

def tokenize(line):
    """Split a row into leading text + an ordered list of numeric cells, left to right.
    ($ x) groups are one cell; bare numbers, percents and lone dashes are one cell each."""
    cells, spans = [], []
    for m in MONEY.finditer(line):
        cells.append((m.start(), num(m.group(1)))); spans.append((m.start(), m.end()))
    # bare tokens that are not inside a ($ ) group
    # A lone dash means "nothing" ONLY when it stands alone. Without the whitespace
    # requirement, "Brody Henry-Logan" contributes a phantom empty cell from its surname and
    # every column on that row shifts one place -- which read his AOV as a SPIFF payment.
    for m in re.finditer(r'(?<![\d,.])(\$?\d[\d,]*\.?\d*%?|(?<=\s)-(?=\s|$))(?![\d,.%])', line):
        if any(s <= m.start() < e for s, e in spans): continue
        cells.append((m.start(), num(m.group(1)))); spans.append((m.start(), m.end()))
    cells.sort()
    first = min([s for s, _ in spans], default=len(line))
    return line[:first].strip(), [v for _, v in cells]

def split_name_store(text):
    """Names run into the store column when they are long ('Sareena Sunshine Gonzalez Bend'),
    so the store is matched off the END of the text, longest label first."""
    t = ' '.join(text.split())
    for s in sorted(STORES, key=len, reverse=True):
        if t.endswith(' ' + s) or t == s:
            return t[:-len(s)].strip(), s
    return t, ''

def parse(path):
    txt = subprocess.run(['pdftotext', '-layout', path, '-'],
                         capture_output=True, text=True, check=True).stdout
    m = re.search(r'Pay Period (\d+)/(\d+)/(\d+) to (\d+)/(\d+)/(\d+)', txt)
    if not m: raise ValueError('no "Pay Period" header in ' + os.path.basename(path))
    start = datetime.date(2000 + int(m.group(3)), int(m.group(1)), int(m.group(2)))
    end   = datetime.date(2000 + int(m.group(6)), int(m.group(4)), int(m.group(5)))

    stated = {}
    for label, key in (('Manager', 'managers'), ('Budtender', 'budtenders')):
        s = re.search(r'Total %s Bonuses Awarded\s+\(?\$\s*([\d,]+\.?\d*)\s*\)?' % label, txt)
        if s: stated[key] = num(s.group(1))

    # TWO REPORT GENERATIONS. The very first report (2025-08-04) uses title-case headers, plain
    # $ amounts, no PAYROLL column at all, and — the one that silently corrupts a row — the
    # budtender AOV and DISCOUNT columns in the OPPOSITE ORDER. Everything from 2025-08-18 on is
    # the layout the app was later ported from.
    gen = 2 if 'MANAGER NAME' in txt else 1

    admin, managers, budtenders, section = None, [], [], None
    for raw in txt.splitlines():
        line = raw.rstrip()
        if not line.strip(): continue
        if re.search(r'^\s*NAME\b', line):                       section = 'admin';  continue
        if re.search(r'MANAGER NAME|^\s*Manager Name\b', line):   section = 'mgr';    continue
        if re.search(r'BUDTENDER NAME|^\s*Budtender Name\b', line): section = 'bud';  continue
        if not section: continue
        text, cells = tokenize(line)
        if not text or not cells: continue                        # spreadsheet padding rows
        if text.startswith(('REVENUE', 'ATTENDANCE', 'Green Cross', 'Pay Period')): continue

        if section == 'admin':
            # NAME | Admin | TARGET | SALES | %goal | stores | maxBonus | BONUS | $/hr | PAYROLL
            if len(cells) < 6: continue
            name = re.sub(r'\s+Admin\s*$', '', text).strip()
            admin = {'name': name, 'target': cells[0], 'sales': cells[1], 'pct_to_goal': cells[2],
                     'stores': cells[3], 'max_bonus': cells[4], 'bonus': cells[5],
                     'per_hour': cells[6] if len(cells) > 7 else None, 'payroll': cells[-1]}
            section = None                                        # exactly one admin row
        elif section == 'mgr':
            # NAME | STORE | TARGET | SALES | DISC% | AOV | TEAM ATT $ | SPIF | BONUS | $/hr | PAYROLL
            if len(cells) < (7 if gen == 2 else 6): continue      # the tier legend rows
            name, store = split_name_store(text)
            if not name: continue
            if gen == 2:
                bonus, per_hour, payroll = cells[-3], cells[-2], cells[-1]
                mid = cells[4:-3]                   # TEAM ATTENDANCE and SPIF, either may be blank
                spiff = round((bonus or 0) - (payroll or 0), 2)
            else:
                bonus, per_hour, payroll = cells[-2], cells[-1], None   # gen1 has no PAYROLL column
                mid, spiff = cells[4:-2], None
            managers.append({'name': name, 'store_label': store, 'target': cells[0], 'sales': cells[1],
                             'discount_pct': cells[2], 'aov': cells[3],
                             'team_attendance': mid[0] if len(mid) >= 1 else None,
                             'spiff': spiff, 'bonus': bonus, 'per_hour': per_hour, 'payroll': payroll})
        elif section == 'bud':
            # NAME | STORE | TXN | SALES | DISC% | AOV | [ATTENDANCE blank] | SPIF | BONUS | $/hr | PAYROLL
            if len(cells) < (7 if gen == 2 else 5): continue
            name, store = split_name_store(text)
            if not name: continue
            if gen == 2:
                bonus, per_hour, payroll = cells[-3], cells[-2], cells[-1]
                sales, discount, aov = cells[1], cells[2], cells[3]
                spiff = round((bonus or 0) - (payroll or 0), 2)
            else:
                # gen1: Transactions | AOV | DISCOUNT | ATTENDANCE | SPIFF | BONUS | $/hr.
                # AOV and DISCOUNT are swapped relative to gen2, there is no SALES column, and
                # no PAYROLL column — so the company/vendor split of this bonus is NOT RECORDED
                # by the document. It is left null rather than guessed: the one row carrying a
                # middle value (A'Donus Gillet) could be reading either ATTENDANCE or SPIFF, and
                # inventing a payroll figure for a period that paid people is the one thing this
                # import must not do. The BONUS the report states is imported as-is.
                bonus, per_hour, payroll = cells[-2], cells[-1], None
                sales, aov, discount, spiff = None, cells[1], cells[2], None
            budtenders.append({'name': name, 'store_label': store, 'txn': int(cells[0] or 0),
                               'sales': sales, 'discount_pct': discount, 'aov': aov,
                               'spiff': spiff, 'bonus': bonus, 'per_hour': per_hour,
                               'payroll': payroll})
    return {'file': os.path.basename(path), 'format': 'gen%d' % gen,
            'pp_start': start.isoformat(), 'pp_end': end.isoformat(),
            'admin': admin, 'managers': managers, 'budtenders': budtenders, 'stated_totals': stated}

def check(p):
    """Every failure here is a silent mis-parse -- a dropped row, or a column read one place over."""
    out = []
    for key, label in (('managers', 'Manager'), ('budtenders', 'Budtender')):
        stated = p['stated_totals'].get(key)
        if stated is None: continue
        got = round(sum(r['bonus'] or 0 for r in p[key]), 2)
        if abs(got - stated) > 0.005:
            out.append('%s bonus total: PDF states %.2f, rows sum to %.2f' % (label, stated, got))
    # An INDEPENDENT check, now that spiff is derived: the sheet's own $/hr column is bonus/80,
    # and it is parsed from a different cell than either input. If the three do not agree the row
    # was read one column over -- which is exactly how an hourly rate got imported as a bonus.
    for r in p['budtenders'] + p['managers']:
        b, h = r['bonus'] or 0, r['per_hour']
        if h is None: continue
        if b and abs(h - b / 80.0) > 0.02:
            out.append('%s: $/hr %.2f is not bonus %.2f / 80' % (r['name'], h, b))
        if r['spiff'] is not None and r['spiff'] < -0.005:
            out.append('%s: negative SPIFF %.2f (payroll exceeds bonus)' % (r['name'], r['spiff']))
    # The Admin (company-wide) bonus was not part of the report until 2025-10-13; the five
    # reports before that genuinely have no such section. Kept as a DATED rule rather than
    # dropped, so an admin row going missing from a modern report is still an error.
    # A section that parsed to nothing cannot fail a totals check, so the empty case has to be
    # its own error. This is how the oldest report first reported "0 problems" while contributing
    # not one budtender: every assertion below it was skipping an empty list.
    for key, label in (('managers', 'Manager'), ('budtenders', 'Budtender')):
        if not p[key]:
            out.append('no %s rows parsed' % label.lower())
        if p['stated_totals'].get(key) is None:
            out.append('no stated %s total found to check against' % label.lower())

    ADMIN_FROM = '2025-10-13'
    if not p['admin'] and p['pp_start'] >= ADMIN_FROM:
        out.append('no admin row (expected from %s onward)' % ADMIN_FROM)
    return out

if __name__ == '__main__':
    d = DEFAULT_DIR; outfile = None
    for i, a in enumerate(sys.argv):
        if a == '--dir' and i + 1 < len(sys.argv): d = sys.argv[i + 1]
        if a == '--out' and i + 1 < len(sys.argv): outfile = sys.argv[i + 1]
    files = sorted(glob.glob(os.path.join(d, '*.pdf')) + glob.glob(os.path.join(d, '*pdf')))
    files = sorted(set(f for f in files if os.path.isfile(f)))
    periods, problems = [], 0
    for f in files:
        try: p = parse(f)
        except Exception as e:
            print('  ✗ %-46s %s' % (os.path.basename(f)[:46], e)); problems += 1; continue
        errs = check(p)
        periods.append(p)
        mark = '✓' if not errs else '✗'
        print('  %s %s %s %2d mgr %2d bud  mgr$%-8s bud$%-8s' % (
            mark, p['pp_start'], p['format'], len(p['managers']), len(p['budtenders']),
            p['stated_totals'].get('managers'), p['stated_totals'].get('budtenders')))
        for e in errs: print('       ! ' + e); problems += 1
    periods.sort(key=lambda p: p['pp_start'])
    if outfile:
        json.dump({'periods': periods}, open(outfile, 'w'), indent=1)
        print('\nwrote %s (%d periods)' % (outfile, len(periods)))
    print('\n%d period(s), %d problem(s)' % (len(periods), problems))
    sys.exit(1 if problems else 0)
