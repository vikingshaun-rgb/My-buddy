'use strict';
/* test-caldav.js — offline logic tests for caldav.js
 * No network. Run: node test-caldav.js
 */

const C = require('./caldav');

let pass = 0, fail = 0;
const failures = [];

function t(name, fn) {
  try {
    const r = fn();
    if (r === true) { pass++; }
    else { fail++; failures.push(`${name} — ${r || 'returned false'}`); }
  } catch (e) {
    fail++; failures.push(`${name} — threw: ${e.message}`);
  }
}

/* --- Shaun's real list names, used throughout --------------------------- */
const LISTS = [
  { id: 'l1', name: 'Family',                          kind: 'reminders', sharedByOther: false, readOnly: false },
  { id: 'l2', name: 'Groceries',                       kind: 'reminders', sharedByOther: true,  readOnly: false },
  { id: 'l3', name: 'Cookies',                         kind: 'reminders', sharedByOther: false, readOnly: false },
  { id: 'l4', name: 'Things To Do Shaun',              kind: 'reminders', sharedByOther: false, readOnly: false },
  { id: 'l5', name: 'Diet List For Shaun',             kind: 'reminders', sharedByOther: false, readOnly: false },
  { id: 'l6', name: 'Bills',                           kind: 'reminders', sharedByOther: true,  readOnly: false },
  { id: 'l7', name: 'To do',                           kind: 'reminders', sharedByOther: true,  readOnly: false },
  { id: 'l8', name: 'Things To Do For Working Oversees', kind: 'reminders', sharedByOther: false, readOnly: false },
  { id: 'l9', name: 'Caravan',                         kind: 'reminders', sharedByOther: true,  readOnly: false },
  { id: 'l10', name: 'Peptides/vitamins',              kind: 'reminders', sharedByOther: false, readOnly: false },
  { id: 'l11', name: 'Reminders',                      kind: 'reminders', sharedByOther: false, readOnly: false }
];

const CALS = [
  { id: 'c1', name: 'Payments',        kind: 'calendar', sharedByOther: true,  readOnly: false },
  { id: 'c2', name: 'Work',            kind: 'calendar', sharedByOther: true,  readOnly: false },
  { id: 'c3', name: 'Family',          kind: 'calendar', sharedByOther: false, readOnly: false },
  { id: 'c4', name: 'School Holidays', kind: 'calendar', sharedByOther: true,  readOnly: false },
  { id: 'c5', name: 'Calendar',        kind: 'calendar', sharedByOther: true,  readOnly: false },
  { id: 'c6', name: 'SHAUN  HEALTH PLAN', kind: 'calendar', sharedByOther: false, readOnly: false },
  { id: 'c7', name: 'Peptides',        kind: 'calendar', sharedByOther: false, readOnly: false }
];

/* --- 1. Spoken item parsing --------------------------------------------- */

t('parses "banana done, milk done"', () => {
  const items = C.parseSpokenItems('banana done, milk done');
  return (items.length === 2 && items[0] === 'banana' && items[1] === 'milk') || JSON.stringify(items);
});

t('parses "banana done milk done bread done"', () => {
  const items = C.parseSpokenItems('banana done milk done bread done');
  return items.length === 3 || JSON.stringify(items);
});

t('parses "tick off milk and bread"', () => {
  const items = C.parseSpokenItems('tick off milk and bread');
  return (items.includes('milk') && items.includes('bread') && items.length === 2) || JSON.stringify(items);
});

t('drops filler words, keeps real items', () => {
  const items = C.parseSpokenItems('got the milk, and the bread is done');
  return (items.includes('milk') && items.includes('bread')) || JSON.stringify(items);
});

t('empty utterance yields nothing', () => {
  return C.parseSpokenItems('').length === 0;
});

/* --- 2. List matching — the ambiguity that matters ----------------------- */

t('"groceries" resolves confidently', () => {
  const r = C.matchList('groceries', LISTS, 'reminders');
  return (r.status === 'match' && r.source.name === 'Groceries') || `${r.status}/${r.source && r.source.name}`;
});

t('"to do" is AMBIGUOUS across three lists, never guessed', () => {
  const r = C.matchList('to do', LISTS, 'reminders');
  return r.status === 'ambiguous' || `got ${r.status} -> ${r.source && r.source.name}`;
});

t('ambiguous "to do" offers the real candidates', () => {
  const r = C.matchList('to do', LISTS, 'reminders');
  const names = (r.candidates || []).map(c => c.name);
  return names.includes('To do') || JSON.stringify(names);
});

t('"bills" resolves confidently', () => {
  const r = C.matchList('bills', LISTS, 'reminders');
  return (r.status === 'match' && r.source.name === 'Bills') || r.status;
});

t('"caravan" resolves confidently', () => {
  const r = C.matchList('caravan', LISTS, 'reminders');
  return (r.status === 'match' && r.source.name === 'Caravan') || r.status;
});

t('nonsense list name returns none', () => {
  const r = C.matchList('xyzzy quux', LISTS, 'reminders');
  return r.status === 'none' || r.status;
});

t('kind filter keeps calendars out of list matching', () => {
  const r = C.matchList('payments', LISTS, 'reminders');
  return r.status === 'none' || `${r.status}/${r.source && r.source.name}`;
});

t('"work" matches the Work CALENDAR when kind is calendar', () => {
  const r = C.matchList('work', CALS, 'calendar');
  return (r.status === 'match' && r.source.name === 'Work') || r.status;
});

/* --- 3. Item matching — loose enough to be useful, strict enough to be safe */

const GROCERIES = [
  { uid: 'g1', title: '2L full cream milk' },
  { uid: 'g2', title: 'Bananas' },
  { uid: 'g3', title: 'Sourdough bread' },
  { uid: 'g4', title: 'Almond milk' }
];

t('"banana" matches "Bananas"', () => {
  const m = C.matchItems(['banana'], GROCERIES);
  return (m.matched.length === 1 && m.matched[0].todo.uid === 'g2') || JSON.stringify(m.matched.map(x => x.todo.title));
});

t('"bread" matches "Sourdough bread"', () => {
  const m = C.matchItems(['bread'], GROCERIES);
  return (m.matched.length === 1 && m.matched[0].todo.uid === 'g3') || JSON.stringify(m.matched.map(x => x.todo.title));
});

t('"milk" is AMBIGUOUS between full cream and almond', () => {
  const m = C.matchItems(['milk'], GROCERIES);
  return (m.matched.length === 0 && m.ambiguous.length === 1) ||
    `matched=${m.matched.length} ambiguous=${m.ambiguous.length}`;
});

t('"almond milk" resolves the ambiguity confidently', () => {
  const m = C.matchItems(['almond milk'], GROCERIES);
  return (m.matched.length === 1 && m.matched[0].todo.uid === 'g4') || JSON.stringify(m.matched.map(x => x.todo.title));
});

t('item not on the list is reported missing, not guessed', () => {
  const m = C.matchItems(['caviar'], GROCERIES);
  return (m.matched.length === 0 && m.missing.includes('caviar')) || JSON.stringify(m);
});

t('one item never ticks two entries', () => {
  const m = C.matchItems(['bananas'], GROCERIES);
  return m.matched.length <= 1 || `matched ${m.matched.length}`;
});

t('two items match two DIFFERENT todos', () => {
  const m = C.matchItems(['bananas', 'bread'], GROCERIES);
  const uids = new Set(m.matched.map(x => x.todo.uid));
  return (m.matched.length === 2 && uids.size === 2) || JSON.stringify(m.matched.map(x => x.todo.title));
});

/* --- 4. Confirmation lines ---------------------------------------------- */

t('tick confirmation names the items', () => {
  const line = C.confirmationLine('tick', {
    items: [{ todo: { title: 'Bananas' } }, { todo: { title: 'Sourdough bread' } }],
    source: { name: 'Groceries', sharedByOther: true }
  });
  return (line.includes('Bananas') && line.includes('Sourdough bread')) || line;
});

t('tick confirmation flags a SHARED list', () => {
  const line = C.confirmationLine('tick', {
    items: [{ todo: { title: 'Bananas' } }],
    source: { name: 'Groceries', sharedByOther: true }
  });
  return line.toLowerCase().includes('shared') || line;
});

t('own list confirmation does not claim shared', () => {
  const line = C.confirmationLine('tick', {
    items: [{ todo: { title: 'Call bank' } }],
    source: { name: 'Things To Do Shaun', sharedByOther: false }
  });
  return !line.toLowerCase().includes('shared') || line;
});

t('add confirmation quotes the new item', () => {
  const line = C.confirmationLine('add', { title: 'Milk', source: { name: 'Groceries', sharedByOther: true } });
  return line.includes('Milk') || line;
});

/* --- 5. Picker defaults -------------------------------------------------- */

t('unknown sources default to OFF for both toggles', () => {
  const merged = C.mergePrefs(LISTS, {});
  return merged.every(s => s.read === false && s.monitor === false) || 'some defaulted on';
});

t('saved prefs are honoured', () => {
  const merged = C.mergePrefs(LISTS, { l2: { read: true, monitor: true }, l10: { read: true, monitor: false } });
  const groceries = merged.find(s => s.id === 'l2');
  const peptides = merged.find(s => s.id === 'l10');
  return (groceries.read && groceries.monitor && peptides.read && !peptides.monitor) || 'prefs not applied';
});

t('readable() includes monitor-only sources', () => {
  const merged = C.mergePrefs(LISTS, { l6: { read: false, monitor: true } });
  return C.readable(merged).some(s => s.id === 'l6') || 'monitor-only excluded from readable';
});

t('monitored() excludes read-only-flagged sources', () => {
  const merged = C.mergePrefs(LISTS, { l10: { read: true, monitor: false } });
  return !C.monitored(merged).some(s => s.id === 'l10') || 'read-only source is being monitored';
});

t('a NEW list appearing later defaults to silent', () => {
  const withNew = [...LISTS, { id: 'l99', name: 'Christmas', kind: 'reminders', sharedByOther: false, readOnly: false }];
  const merged = C.mergePrefs(withNew, { l2: { read: true, monitor: true } });
  const fresh = merged.find(s => s.id === 'l99');
  return (!fresh.read && !fresh.monitor) || 'new list started talking on its own';
});

/* --- 6. iCalendar parsing ------------------------------------------------ */

const SAMPLE_ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'UID:evt-1',
  'SUMMARY:Geeks2U job - Chermside',
  'LOCATION:Chermside QLD',
  'DTSTART:20260721T090000Z',
  'DTEND:20260721T103000Z',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:evt-2',
  'SUMMARY:School holidays',
  'DTSTART;VALUE=DATE:20260722',
  'END:VEVENT',
  'BEGIN:VTODO',
  'UID:todo-1',
  'SUMMARY:Pay electricity',
  'DUE;VALUE=DATE:20260721',
  'END:VTODO',
  'END:VCALENDAR'
].join('\r\n');

t('parses events and todos out of one payload', () => {
  const p = C.parseIcs(SAMPLE_ICS);
  return (p.events.length === 2 && p.todos.length === 1) || `${p.events.length}/${p.todos.length}`;
});

t('reads summary and location', () => {
  const p = C.parseIcs(SAMPLE_ICS);
  const e = p.events.find(x => x.uid === 'evt-1');
  return (e.title.includes('Chermside') && e.location === 'Chermside QLD') || JSON.stringify(e);
});

t('DATE-only value is flagged all-day', () => {
  const p = C.parseIcs(SAMPLE_ICS);
  const e = p.events.find(x => x.uid === 'evt-2');
  return e.allDay === true || `allDay=${e.allDay}`;
});

t('timed event is NOT flagged all-day', () => {
  const p = C.parseIcs(SAMPLE_ICS);
  const e = p.events.find(x => x.uid === 'evt-1');
  return e.allDay === false || `allDay=${e.allDay}`;
});

t('handles folded lines (RFC 5545)', () => {
  const folded = [
    'BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:f1',
    'SUMMARY:A very long job description that wraps',
    ' across two lines',
    'DTSTART:20260721T090000Z', 'END:VEVENT', 'END:VCALENDAR'
  ].join('\r\n');
  const p = C.parseIcs(folded);
  return p.events[0].title.includes('across two lines') || p.events[0].title;
});

t('unescapes commas and newlines in text', () => {
  const esc = [
    'BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:e1',
    'SUMMARY:Milk\\, bread and eggs',
    'DTSTART:20260721T090000Z', 'END:VEVENT', 'END:VCALENDAR'
  ].join('\r\n');
  const p = C.parseIcs(esc);
  return p.events[0].title === 'Milk, bread and eggs' || p.events[0].title;
});

t('unparseable payload yields nothing rather than throwing', () => {
  const p = C.parseIcs('this is not a calendar');
  return (p.events.length === 0 && p.todos.length === 0) || 'invented data';
});

t('completed todo is marked completed', () => {
  const done = [
    'BEGIN:VCALENDAR', 'BEGIN:VTODO', 'UID:t9',
    'SUMMARY:Old task', 'STATUS:COMPLETED', 'END:VTODO', 'END:VCALENDAR'
  ].join('\r\n');
  const p = C.parseIcs(done);
  return p.todos[0].completed === true || 'not marked complete';
});

/* --- 7. Recurrence ------------------------------------------------------- */

t('weekly recurrence expands into the window', () => {
  const ev = {
    uid: 'r1', title: 'Weekly shop',
    start: new Date('2026-07-02T09:00:00Z'),
    end: new Date('2026-07-02T10:00:00Z'),
    rrule: 'FREQ=WEEKLY'
  };
  const out = C.expandRecurring(ev, new Date('2026-07-01'), new Date('2026-07-31'));
  return out.length >= 4 || `got ${out.length}`;
});

t('UNTIL stops the expansion', () => {
  const ev = {
    uid: 'r2', title: 'Short series',
    start: new Date('2026-07-02T09:00:00Z'),
    end: new Date('2026-07-02T10:00:00Z'),
    rrule: 'FREQ=WEEKLY;UNTIL=20260716T000000Z'
  };
  const out = C.expandRecurring(ev, new Date('2026-07-01'), new Date('2026-08-31'));
  return out.length <= 3 || `got ${out.length}`;
});

t('unsupported RRULE is flagged, not silently dropped', () => {
  const ev = {
    uid: 'r3', title: 'Odd one',
    start: new Date('2026-07-02T09:00:00Z'),
    rrule: 'FREQ=SECONDLY'
  };
  const out = C.expandRecurring(ev, new Date('2026-07-01'), new Date('2026-07-31'));
  return (out.length === 1 && out[0].recurringUnsupported) || JSON.stringify(out.map(o => o.recurringUnsupported));
});

t('non-recurring event passes through untouched', () => {
  const ev = { uid: 'r4', title: 'One off', start: new Date('2026-07-02T09:00:00Z') };
  const out = C.expandRecurring(ev, new Date('2026-07-01'), new Date('2026-07-31'));
  return (out.length === 1 && !out[0].recurringInstance) || JSON.stringify(out);
});

/* --- 8. Day brief -------------------------------------------------------- */

const NOW = new Date('2026-07-21T08:00:00');

function ev(title, hour, opts = {}) {
  const s = new Date(NOW); s.setHours(hour, 0, 0, 0);
  const e = new Date(s.getTime() + 3600000);
  return { uid: title, title, start: s, end: e, allDay: false, sourceName: opts.source || 'Calendar', sharedByOther: !!opts.shared };
}

t('brief separates yours from shared', () => {
  const b = C.buildDayBrief([ev('Chermside job', 10), ev('Gracie dance', 14, { shared: true, source: 'Family' })], [], { now: NOW });
  return (b.spoken.includes('You\'ve got') && b.spoken.toLowerCase().includes('shared')) || b.spoken;
});

t('empty day says so plainly', () => {
  const b = C.buildDayBrief([], [], { now: NOW });
  return b.spoken.toLowerCase().includes('nothing left') || b.spoken;
});

t('overdue items lead the brief', () => {
  const past = new Date(NOW); past.setDate(past.getDate() - 3);
  const b = C.buildDayBrief([], [{ title: 'Pay rego', due: past, completed: false, sourceName: 'Bills' }], { now: NOW });
  return b.spoken.toLowerCase().startsWith('pay rego is overdue') || b.spoken;
});

t('counts are accurate', () => {
  const past = new Date(NOW); past.setDate(past.getDate() - 1);
  const todayDue = new Date(NOW); todayDue.setHours(17, 0, 0, 0);
  const b = C.buildDayBrief(
    [ev('A', 10), ev('B', 15)],
    [{ title: 'Old', due: past, completed: false, sourceName: 'Bills' },
     { title: 'Today', due: todayDue, completed: false, sourceName: 'Bills' }],
    { now: NOW }
  );
  return (b.counts.events === 2 && b.counts.overdue === 1 && b.counts.dueToday === 1) || JSON.stringify(b.counts);
});

t('completed todos never appear in the brief', () => {
  const todayDue = new Date(NOW); todayDue.setHours(17, 0, 0, 0);
  const b = C.buildDayBrief([], [{ title: 'Done thing', due: todayDue, completed: true, sourceName: 'Bills' }], { now: NOW });
  return b.counts.dueToday === 0 || `dueToday=${b.counts.dueToday}`;
});

/* --- 9. Change detection ------------------------------------------------- */

t('new event is detected as added', () => {
  const fresh = [ev('New job', 11)];
  const ch = C.detectChanges(fresh, {});
  return (ch.added.length === 1 && ch.any) || JSON.stringify(ch.added.length);
});

t('unchanged event produces no noise', () => {
  const e = ev('Same job', 11);
  const seen = { [e.uid]: { title: e.title, start: e.start.toISOString(), sourceName: e.sourceName } };
  const ch = C.detectChanges([e], seen);
  return ch.any === false || JSON.stringify({ a: ch.added.length, m: ch.moved.length, r: ch.removed.length });
});

t('moved event is detected', () => {
  const e = ev('Job', 11);
  const seen = { [e.uid]: { title: e.title, start: new Date('2026-07-21T09:00:00').toISOString(), sourceName: e.sourceName } };
  const ch = C.detectChanges([e], seen);
  return ch.moved.length === 1 || JSON.stringify(ch);
});

t('cancelled event is detected as removed', () => {
  const seen = { gone: { title: 'Cancelled job', start: new Date().toISOString(), sourceName: 'Work' } };
  const ch = C.detectChanges([], seen);
  return ch.removed.length === 1 || JSON.stringify(ch.removed);
});

t('nextSeen carries forward for the next poll', () => {
  const e = ev('Job', 11);
  const ch = C.detectChanges([e], {});
  return !!ch.nextSeen[e.uid] || 'nextSeen empty';
});

/* --- 10. Free/busy + slots ---------------------------------------------- */

t('clash is detected', () => {
  const events = [ev('Job', 10)];
  const s = new Date(NOW); s.setHours(10, 30, 0, 0);
  const e = new Date(NOW); e.setHours(11, 0, 0, 0);
  const r = C.isFree(events, s, e);
  return (r.free === false && r.clashes.length === 1) || JSON.stringify(r);
});

t('gap is reported free', () => {
  const events = [ev('Job', 10)];
  const s = new Date(NOW); s.setHours(13, 0, 0, 0);
  const e = new Date(NOW); e.setHours(14, 0, 0, 0);
  return C.isFree(events, s, e).free === true || 'reported busy';
});

t('all-day events do not block the whole day', () => {
  const allDay = { uid: 'ad', title: 'School holidays', start: C.startOfDay(NOW), end: C.endOfDay(NOW), allDay: true, sourceName: 'School Holidays' };
  const s = new Date(NOW); s.setHours(13, 0, 0, 0);
  const e = new Date(NOW); e.setHours(14, 0, 0, 0);
  return C.isFree([allDay], s, e).free === true || 'all-day blocked a slot';
});

t('findSlots avoids booked time', () => {
  const events = [ev('Job', 10), ev('Second job', 11)];
  const slots = C.findSlots(events, { from: new Date(NOW), to: new Date(NOW.getTime() + 864e5), minutes: 60 });
  const clashing = slots.filter(s => C.isFree(events, s.start, s.end).free === false);
  return clashing.length === 0 || `${clashing.length} slots clash`;
});

t('findSlots respects working hours', () => {
  const slots = C.findSlots([], { from: new Date(NOW), to: new Date(NOW.getTime() + 864e5), minutes: 60, dayStart: 9, dayEnd: 17 });
  const bad = slots.filter(s => s.start.getHours() < 9 || s.end.getHours() > 17);
  return bad.length === 0 || `${bad.length} outside hours`;
});

/* --- 11. Pattern detection ---------------------------------------------- */

t('stays QUIET with too little history', () => {
  const hist = [{ title: 'Shopping', start: new Date('2026-07-01') }];
  return C.detectPatterns(hist).length === 0 || 'claimed a pattern from one data point';
});

t('detects a weekly rhythm', () => {
  const hist = [
    { title: 'Shopping', start: new Date('2026-07-02T09:00:00') },
    { title: 'Shopping', start: new Date('2026-07-09T09:00:00') },
    { title: 'Shopping', start: new Date('2026-07-16T09:00:00') },
    { title: 'Shopping', start: new Date('2026-07-23T09:00:00') }
  ];
  const p = C.detectPatterns(hist);
  return (p.length === 1 && p[0].averageGapDays === 7 && p[0].weekday === 'Thursday') || JSON.stringify(p);
});

t('irregular history yields no pattern', () => {
  const hist = [
    { title: 'Random', start: new Date('2026-07-01') },
    { title: 'Random', start: new Date('2026-07-03') },
    { title: 'Random', start: new Date('2026-07-28') }
  ];
  return C.detectPatterns(hist).length === 0 || 'claimed a pattern from noise';
});

/* --- 12. Memory tagging -------------------------------------------------- */

t('calendar memory is tagged tool-sourced, never stated', () => {
  const line = C.memoryLineForEvent(ev('Chermside job', 10));
  return (line.origin === 'tool' && line.kind === 'calendar') || JSON.stringify(line);
});

t('completion memory is tagged tool-sourced', () => {
  const line = C.memoryLineForCompletion({ title: 'Milk', sourceName: 'Groceries' });
  return line.origin === 'tool' || JSON.stringify(line);
});

t('shared events are attributed in memory', () => {
  const line = C.memoryLineForEvent(ev('Gracie dance', 14, { shared: true, source: 'Family' }));
  return line.text.includes('shared') || line.text;
});

/* --- 13. Write safety ---------------------------------------------------- */

t('addTodo has a read-only guard before any network call', () => {
  const src = String(C.addTodo);
  const guardAt = src.indexOf('readOnly');
  const putAt = src.indexOf("dav('PUT'");
  return (guardAt > -1 && putAt > -1 && guardAt < putAt) || 'read-only check is missing or runs after the write';
});

t('createEvent has a read-only guard before any network call', () => {
  const src = String(C.createEvent);
  const guardAt = src.indexOf('readOnly');
  const putAt = src.indexOf("dav('PUT'");
  return (guardAt > -1 && putAt > -1 && guardAt < putAt) || 'read-only check is missing or runs after the write';
});

t('completeTodo sends If-Match so a stale tick cannot clobber a shared list', () => {
  const src = String(C.completeTodo);
  return (src.includes('If-Match') && src.includes('412')) || 'no optimistic-concurrency guard';
});

t('every write function is exported', () => {
  return ['completeTodo', 'addTodo', 'createEvent', 'prepareTickOff'].every(k => typeof C[k] === 'function');
});

t('prepareTickOff never writes — it returns needsConfirmation', () => {
  const src = String(C.prepareTickOff);
  return (src.includes('needsConfirmation') && !src.includes('completeTodo(')) || 'prepareTickOff may be writing directly';
});

/* --- run ---------------------------------------------------------------- */

console.log('');
console.log('  CalDAV module — logic tests');
console.log('  ' + '-'.repeat(44));
if (failures.length) {
  for (const f of failures) console.log('  FAIL  ' + f);
  console.log('');
}
console.log(`  ${pass} passed, ${fail} failed`);
console.log('');
process.exit(fail ? 1 : 0);
