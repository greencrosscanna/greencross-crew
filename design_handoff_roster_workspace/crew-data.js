/* Sample GX Crew roster data for design work.
   Field names and value shapes copied from apps-script/Code.gs (rosterRow builder + rowFlags_)
   and crew.js (COLUMNS, permit cells). No real payroll or PII. */

export const TODAY = '2026-08-24';

export const STORES = {
  'bend':      { name: 'Bend',      color: '#22d3ee', order: 1 },
  'center':    { name: 'Center',    color: '#60a5fa', order: 2 },
  'river-rd':  { name: 'River Rd',  color: '#a78bfa', order: 3 },
  'corporate': { name: 'Corporate', color: '',        order: null }
};

export const ROLE_TITLES = ['Admin', 'Store Manager', 'Assistant Manager', 'Budtender'];
export const SHIRT_SIZES = ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL'];

/* avatar_config shapes match buildAvatarUrl in crew.js */
const A = (o) => JSON.stringify(Object.assign({
  skinColor: 'edb98a', top: 'shortFlat', hairColor: '4a312c', hatColor: '262e33',
  eyes: 'default', eyebrows: 'default', mouth: 'smile', facialHair: '_none',
  facialHairColor: '2c1b18', clothing: 'shirtCrewNeck', clothesColor: '262e33',
  clothingGraphic: 'bat', accessories: '_none', accessoriesColor: '3c4f5c'
}, o));

const R = [
  ['00', 'e00', 'Sky Pinnick', '', 'corporate', 'Admin', '2019-03-04', '7yr 5mo', '—', 'L', '04-12', 'OLCC-104882', 'Active', '2027-02-11', A({ top: '_gchat', clothing: 'blazerAndShirt', clothesColor: '25557c' }), { user_id: 'sky@greencrosscanna.com', dutchie: '1001', optOut: true }],
  ['02', 'e02', 'Michael Kettler', 'Mike', 'corporate', 'Admin', '2019-08-19', '7yr 0mo', '—', 'XL', '11-02', 'OLCC-110254', 'Active', '2026-11-30', A({ top: 'shortCurly', facialHair: 'beardMedium', clothing: 'blazerAndSweater', clothesColor: '3c4f5c' }), { user_id: 'mike@greencrosscanna.com', dutchie: '1004' }],
  ['04', 'e04', 'Dana Whitcomb', '', 'bend', 'Store Manager', '2020-01-13', '6yr 7mo', '27.00', 'M', '07-21', 'OLCC-118330', 'Active', '2026-10-02', A({ top: 'bob', hairColor: 'a55728', clothing: 'collarAndSweater', clothesColor: '929598' }), { user_id: 'dana.w@greencrosscanna.com', dutchie: '1012' }],
  ['05', 'e05', 'Rebeka Perez', 'Bekah', 'center', 'Store Manager', '2020-06-02', '6yr 2mo', '26.50', 'S', '02-28', 'OLCC-120918', 'Active', '2026-09-14', A({ top: 'longButNotTooLong', hairColor: '2c1b18', accessories: 'round', accessoriesColor: '262e33' }), { user_id: 'rebeka.p@greencrosscanna.com', dutchie: '1015' }],
  ['07', 'e07', 'Tomas Iverson', '', 'river-rd', 'Store Manager', '2021-02-08', '5yr 6mo', '26.00', 'L', '', 'OLCC-125512', 'Active', '2027-04-19', '', { dutchie: '1021' }],
  ['09', 'e09', 'Priya Raman', '', 'bend', 'Assistant Manager', '2021-07-26', '5yr 1mo', '23.25', 'S', '05-09', 'OLCC-131007', 'Active', '2026-12-08', A({ top: 'straight02', hairColor: '2c1b18', skinColor: 'd08b5b' }), { user_id: 'priya.r@greencrosscanna.com', dutchie: '1029' }],
  ['11', 'e11', 'Colin Frayne', '', 'center', 'Assistant Manager', '2021-11-15', '4yr 9mo', '22.75', 'XL', '09-30', 'OLCC-134410', 'Active', '2026-09-05', '', { dutchie: '1033' }],
  ['12', 'e12', 'Nadia Osei', '', 'river-rd', 'Assistant Manager', '2022-01-10', '4yr 7mo', '22.50', 'M', '03-17', 'OLCC-136288', 'Active', '2027-01-22', A({ top: 'dreads01', skinColor: 'ae5d29', hairColor: '2c1b18', clothing: 'shirtVNeck', clothesColor: 'a7ffc4' }), { user_id: 'nadia.o@greencrosscanna.com', dutchie: '1036' }],
  ['14', 'e14', 'Wes Tanaka', '', 'bend', 'Budtender', '2022-04-04', '4yr 4mo', '19.00', 'M', '12-14', 'OLCC-139741', 'Active', '2026-10-27', '', { dutchie: '1041' }],
  ['15', 'e15', 'Marisol Vega', 'Mari', 'bend', 'Budtender', '2022-06-20', '4yr 2mo', '18.75', 'S', '08-31', 'OLCC-141052', 'Active', '2026-08-31', A({ top: 'curly', hairColor: '2c1b18', skinColor: 'd08b5b', mouth: 'twinkle' }), { dutchie: '1044' }],
  ['17', 'e17', 'Devon Blackwell', '', 'center', 'Budtender', '2022-09-12', '3yr 11mo', '18.50', 'L', '01-19', 'OLCC-143390', 'Active', '2027-03-08', '', { dutchie: '1049' }],
  ['18', 'e18', 'Hana Lindqvist', '', 'center', 'Budtender', '2022-10-31', '3yr 10mo', '18.50', 'XS', '06-06', 'OLCC-144128', 'Active', '2026-11-16', A({ top: 'straightAndStrand', hairColor: 'd6b370', clothing: 'graphicShirt', clothingGraphic: 'pizza', clothesColor: 'ff5c5c' }), { dutchie: '1051' }],
  ['19', 'e19', 'Andre Kimball', '', 'river-rd', 'Budtender', '2023-01-09', '3yr 7mo', '18.25', '2XL', '', 'OLCC-146007', 'Active', '2026-08-18', '', { dutchie: '1053' }],
  ['21', 'e21', 'Joslyn Meeker', 'Joss', 'river-rd', 'Budtender', '2023-03-27', '3yr 5mo', '18.25', 'M', '10-05', '', '', '', A({ top: 'shaggy', hairColor: 'c93305', accessories: 'wayfarers' }), { dutchie: '1057' }],
  ['22', 'e22', 'Grant Oyelaran', '', 'bend', 'Budtender', '2023-05-15', '3yr 3mo', '18.00', 'L', '04-02', 'OLCC-148821', 'Active', '2027-05-30', '', { dutchie: '1060' }],
  ['24', 'e24', 'Sabine Roche', '', 'center', 'Budtender', '2023-08-07', '3yr 0mo', '18.00', 'S', '07-08', 'OLCC-150440', 'Active', '2026-12-19', A({ top: 'bun', hairColor: '4a312c', clothing: 'hoodie', clothesColor: '5199e4' }), { dutchie: '1064' }],
  ['25', 'e25', 'Iggy Barrera', '', 'bend', 'Budtender', '2023-10-16', '2yr 10mo', '17.75', 'M', '02-11', 'OLCC-151903', 'Expired', '2026-07-02', '', { dutchie: '1067' }],
  ['27', 'e27', 'Lena Kowalczyk', '', 'river-rd', 'Budtender', '2024-01-22', '2yr 7mo', '17.50', 'S', '11-25', 'OLCC-153710', 'Active', '2027-02-04', A({ top: 'frizzle', hairColor: 'b58143', mouth: 'default' }), { dutchie: '1071' }],
  ['28', 'e28', 'Casey Nordholm', '', 'center', 'Budtender', '2024-03-11', '2yr 5mo', '17.50', 'L', '', 'OLCC-154466', 'Active', '2026-09-28', '', { dutchie: '1073' }],
  ['30', 'e30', 'Tavi Ruiz', '', 'bend', 'Budtender', '2024-05-28', '2yr 3mo', '17.25', 'M', '05-30', 'OLCC-156201', 'Active', '2027-06-11', '', { dutchie: '1076' }],
  ['31', 'e31', 'Bree Hollister', '', 'river-rd', 'Budtender', '2024-07-15', '2yr 1mo', '17.25', 'XS', '09-12', 'OLCC-157088', 'Active', '2026-10-19', A({ top: 'miaWallace', hairColor: '2c1b18', accessories: 'prescription02' }), { dutchie: '1079' }],
  ['33', 'e33', 'Omar Haddad', '', 'center', 'Budtender', '2024-09-30', '1yr 10mo', '17.00', 'L', '01-04', 'OLCC-158944', 'Active', '2027-01-08', '', { dutchie: '1082' }],
  ['34', 'e34', 'Rowan Deitch', '', 'bend', 'Budtender', '2024-11-18', '1yr 9mo', '17.00', 'M', '', '', '', '', '', { dutchie: '1085' }],
  ['36', 'e36', 'Yuki Sorensen', '', 'river-rd', 'Budtender', '2025-01-27', '1yr 6mo', '16.75', 'S', '08-14', 'OLCC-160512', 'Active', '2026-11-02', A({ top: 'shortWaved', hairColor: '2c1b18', skinColor: 'f8d25c', clothing: 'shirtScoopNeck', clothesColor: 'ffafb9' }), { dutchie: '1088' }],
  ['37', 'e37', 'Beau Trask', '', 'center', 'Budtender', '2025-03-17', '1yr 5mo', '16.75', 'XL', '06-22', 'OLCC-161377', 'Active', '2027-04-01', '', { dutchie: '1091' }],
  ['39', 'e39', 'Imani Cross', '', 'bend', 'Budtender', '2025-06-02', '1yr 2mo', '16.50', 'M', '03-08', 'OLCC-162840', 'Suspended', '2027-05-14', '', { dutchie: '1094' }],
  ['40', 'e40', 'Petra Nilsen', '', 'river-rd', 'Budtender', '2025-08-11', '1yr 0mo', '16.50', 'S', '12-30', 'OLCC-163722', 'Active', '2026-09-21', A({ top: 'froBand', hairColor: 'e8e1e1', skinColor: 'ffdbb4' }), { dutchie: '1097' }],
  ['42', 'e42', 'Silas Broome', '', 'center', 'Budtender', '2025-11-04', '0yr 9mo', '16.25', 'L', '07-15', 'OLCC-164918', 'Active', '2027-02-27', '', { dutchie: '1101' }],
  ['43', 'e43', 'Ada Fennimore', '', 'bend', 'Budtender', '2026-02-16', '0yr 6mo', '', 'M', '10-23', 'OLCC-166003', 'Active', '2027-03-19', '', { dutchie: '1104' }],
  ['45', 'e45', 'Cyrus Mbeki', '', '', 'Budtender', '', '—', '', '', '', '', '', '', '', { dutchie: '' }],
  ['46', 'e46', '', '', 'center', 'Budtender', '2026-06-08', '0yr 2mo', '16.00', 'S', '', 'OLCC-167551', 'Active', '2027-06-30', '', { dutchie: '1109' }],
  ['48', 'e48', 'Wendell Pike', '', 'river-rd', 'Assistant Manager', '2026-07-20', '0yr 1mo', '21.50', 'L', '', 'OLCC-168214', 'Active', '2027-07-14', '', { dutchie: '1112' }]
];

const RETIRED = [
  ['08', 'e08', 'Marcus Delaney', '', 'center', 'Budtender', '2021-05-03', '3yr 2mo', '18.00', 'L', '', 'OLCC-129440', 'Expired', '2025-04-30', '', { dutchie: '1026' }],
  ['13', 'e13', 'Erin Vasquez', '', 'bend', 'Assistant Manager', '2022-02-14', '2yr 8mo', '21.00', 'M', '05-19', 'OLCC-137660', 'Expired', '2025-11-11', '', { dutchie: '1038', user_id: 'erin.v@greencrosscanna.com' }],
  ['20', 'e20', 'Kofi Adjei', '', 'river-rd', 'Budtender', '2023-02-21', '1yr 4mo', '17.50', 'XL', '', '', '', '', '', { dutchie: '1055' }],
  ['29', 'e29', 'Talia Brenner', '', 'center', 'Budtender', '2024-04-08', '0yr 11mo', '17.00', 'S', '08-02', 'OLCC-155380', 'Active', '2026-05-27', '', { dutchie: '1075' }]
];

function daysLeft(iso) {
  if (!iso) return null;
  return Math.round((new Date(iso + 'T00:00:00') - new Date(TODAY + 'T00:00:00')) / 86400000);
}

const MANAGER_RE = /manager/i;

function rowFlags(r) {
  const f = [];
  if (!String(r.name || '').trim()) f.push('name');
  if (r.retired) return f;
  if (!r.employee_number) f.push('employee_number');
  if (!r.hire_date) f.push('hire_date');
  if (!r.store) f.push('store');
  if (r.role_is_default) f.push('role');
  if (MANAGER_RE.test(r.role) && !String(r.user_id || '').trim()) f.push('no_account');
  if (!r.wage) f.push('wage');
  if (!r.birthday) f.push('birthday');
  if (!r.permit_number) f.push('permit');
  else if (r.permit_days_left != null && r.permit_days_left < 0) f.push('permit_expired');
  if (r.permit_status && ['active', 'valid'].indexOf(String(r.permit_status).toLowerCase()) < 0)
    f.push('permit_status');
  return f;
}

function build(t, retired) {
  const [num, id, name, nick, store, role, hire, tenure, wage, tee, bday, permit, pstatus, pexp, ava, extra] = t;
  const r = {
    employee_number: num, employee_id: id, name, preferred_name: nick,
    store, role, role_is_default: false,
    hire_date: hire, time_with_company: tenure,
    wage: wage === '—' ? '' : wage,
    wage_hidden: wage === '—',
    shirt_size: tee, birthday: bday,
    permit_number: permit, permit_status: pstatus, permit_expires: pexp,
    permit_days_left: daysLeft(pexp),
    avatar_config: ava, avatar_seed: num,
    retired: !!retired,
    user_id: (extra && extra.user_id) || '',
    dutchie_employee_id: (extra && extra.dutchie) || '',
    celebrations_opt_out: !!(extra && extra.optOut)
  };
  r.flags = rowFlags(r);
  return r;
}

export const ROWS = R.map((t) => build(t, false));
export const RETIRED_ROWS = RETIRED.map((t) => build(t, true));

/* Review queue items — shapes from Code.gs review_report / crew.js renderReview */
export const REVIEW = [
  { id: 'rv1', kind: 'name_spelling', severity: 'high', name: 'Michael Kettler', source: 'METRC',
    detail: 'METRC has the legal spelling. Dutchie is where this name came from, and a Dutchie admin can edit it — METRC wins on legal spelling.',
    current_value: 'Michael Kettler', proposed_value: 'Michael J. Kettler' },
  { id: 'rv2', kind: 'duplicate', severity: 'high', name: 'Marisol Vega', source: 'Dutchie seed',
    detail: 'Two identity rows resolve to the same person. Keeping #15 preserves the Dutchie id and employee number.',
    current_value: 'Marisol Vega · #15', proposed_value: 'Mari Vega · #47', merge_from_name: 'Mari Vega' },
  { id: 'rv3', kind: 'permit_expired', severity: 'high', name: 'Iggy Barrera', source: 'METRC',
    detail: 'OLCC permit OLCC-151903 expired 2026-07-02. They are still active on the roster and still selling.',
    current_value: '2026-07-02', proposed_value: '' },
  { id: 'rv4', kind: 'retired_with_access', severity: 'warn', name: 'Erin Vasquez', source: 'METRC access audit',
    detail: 'Retired in Crew on 2024-10-30 but still shows as an active user in METRC.',
    current_value: 'Retired here', proposed_value: 'Still active in METRC' },
  { id: 'rv5', kind: 'role', severity: 'warn', name: 'Wendell Pike', source: 'Leaderboard',
    detail: 'Leaderboard groups this person as Budtender; Crew holds Assistant Manager. Leaderboard wins on role.',
    current_value: 'Assistant Manager', proposed_value: 'Budtender' },
  { id: 'rv6', kind: 'missing_field', severity: 'warn', name: 'Cyrus Mbeki', source: 'GX Core',
    detail: 'Identity row is active but holds no store, no hire date and no Dutchie id. Likely a partial write.',
    current_value: '', proposed_value: '' },
  { id: 'rv7', kind: 'missing_permit', severity: 'warn', name: 'Joslyn Meeker', source: 'METRC',
    detail: 'No OLCC permit number on file. METRC has no matching record under this name.',
    current_value: '', proposed_value: '' },
  { id: 'rv8', kind: 'permit_expiring', severity: 'info', name: 'Colin Frayne', source: 'METRC',
    detail: 'Permit expires in 12 days.', current_value: '2026-09-05', proposed_value: '' }
];

export const EOM_CURRENT = 'e18';
export const EOM_HISTORY = [
  { employee_id: 'e18', name: 'Hana Lindqvist', started_at: '2026-08-01', current: true, set_by: 'sky' },
  { employee_id: 'e22', name: 'Grant Oyelaran', started_at: '2026-07-01', ended_at: '2026-07-31', set_by: 'mike' },
  { employee_id: 'e12', name: 'Nadia Osei', started_at: '2026-06-01', ended_at: '2026-06-30', set_by: 'sky' },
  { nobody: true, started_at: '2026-05-01', ended_at: '2026-05-31' },
  { employee_id: 'e15', name: 'Marisol Vega', started_at: '2026-03-01', ended_at: '2026-04-30', backfilled: true }
];
