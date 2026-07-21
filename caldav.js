'use strict';
/* =============================================================================
 * caldav.js — Vision calendar + reminders module (STANDALONE)
 *
 * No dependencies. Node 18+ (uses global fetch). Talks CalDAV to iCloud and
 * plain HTTPS to ICS subscription feeds.
 *
 * Designed to be dropped into server.js with:
 *     const CAL = require('./caldav');
 * ...and wired to the existing brief / watcher / router / memory layers.
 * Nothing in here assumes anything about server.js.
 *
 * CREDENTIALS (same ones already on Render for IMAP):
 *   ICLOUD_USER     – appleid@icloud.com
 *   ICLOUD_APP_PW   – app-specific password
 *   GEEKS2U_ICS_URL – full https ICS feed URL (optional)
 *
 * Everything is read-only unless you call a write function, and every write
 * function is designed to be preceded by a spoken read-back confirmation.
 * ========================================================================== */

const ICLOUD_CALDAV = 'https://caldav.icloud.com';

/* ---------------------------------------------------------------------------
 * 1. LOW-LEVEL HTTP
 * ------------------------------------------------------------------------ */

function authHeader(user, pw) {
  return 'Basic ' + Buffer.from(`${user}:${pw}`).toString('base64');
}

const DAV_TIMEOUT_MS = 12000;

// Every network call is bounded. A hung endpoint would otherwise block the
// 15-minute watcher indefinitely, and the next tick would pile in behind it.
async function withTimeout(ms, fn) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try { return await fn(ctl.signal); }
  finally { clearTimeout(timer); }
}

async function dav(method, url, { user, pw, body, depth = '0', contentType = 'application/xml; charset=utf-8', extraHeaders = {}, timeout = DAV_TIMEOUT_MS } = {}) {
  const headers = {
    Authorization: authHeader(user, pw),
    Depth: depth,
    'Content-Type': contentType,
    'User-Agent': 'Vision/1.0',
    ...extraHeaders
  };
  try {
    return await withTimeout(timeout, async signal => {
      const res = await fetch(url, { method, headers, body, signal });
      const text = await res.text().catch(() => '');
      return { status: res.status, ok: res.status >= 200 && res.status < 300, text, headers: res.headers };
    });
  } catch (e) {
    const timedOut = e && (e.name === 'AbortError' || /abort/i.test(String(e.message || '')));
    return { status: timedOut ? 504 : 0, ok: false, text: '', error: timedOut ? `timed out after ${timeout}ms` : String(e.message || e) };
  }
}

/* ---------------------------------------------------------------------------
 * 2. TINY XML HELPERS
 * CalDAV responses are namespaced XML. Rather than pull in a parser we do
 * targeted extraction — this is deliberate: the shapes are narrow and stable,
 * and a hand-rolled reader is debuggable when Apple returns something odd.
 * ------------------------------------------------------------------------ */

function stripNs(tag) {
  return tag.replace(/^[a-zA-Z0-9_-]+:/, '');
}

// Return array of inner strings for every <...:tag> ... </...:tag>
function xmlAll(xml, tag) {
  const out = [];
  const re = new RegExp(`<(?:[a-zA-Z0-9_-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[a-zA-Z0-9_-]+:)?${tag}>`, 'g');
  let m;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

function xmlOne(xml, tag) {
  const all = xmlAll(xml, tag);
  return all.length ? all[0] : '';
}

// Self-closing or empty presence check, e.g. <C:calendar/>
function xmlHasTag(xml, tag) {
  const re = new RegExp(`<(?:[a-zA-Z0-9_-]+:)?${tag}(\\s[^>]*)?/>|<(?:[a-zA-Z0-9_-]+:)?${tag}(\\s[^>]*)?>`, 'i');
  return re.test(xml);
}

function xmlText(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

function xmlEscape(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Split a multistatus into individual <response> blocks
function responses(xml) {
  return xmlAll(xml, 'response');
}

function absoluteUrl(href, base = ICLOUD_CALDAV) {
  const h = xmlText(href);
  if (!h) return '';
  if (/^https?:\/\//i.test(h)) return h;
  try {
    return new URL(h, base).toString();
  } catch {
    return base.replace(/\/$/, '') + (h.startsWith('/') ? h : '/' + h);
  }
}

/* ---------------------------------------------------------------------------
 * 3. DISCOVERY
 *
 * This is the fiddly part and the thing most likely to break, so it runs as
 * its own explicit step with its own error reporting. The chain is:
 *
 *   /.well-known/caldav  ->  current-user-principal
 *                        ->  calendar-home-set
 *                        ->  PROPFIND Depth:1 for the collections
 *
 * Apple frequently answers step 1 with a redirect to a per-user shard host
 * (pNN-caldav.icloud.com) — we follow whatever host comes back rather than
 * assuming the generic one.
 * ------------------------------------------------------------------------ */

const PROP_PRINCIPAL = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop><d:current-user-principal/></d:prop>
</d:propfind>`;

const PROP_HOME = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><c:calendar-home-set/></d:prop>
</d:propfind>`;

const PROP_COLLECTIONS = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"
            xmlns:cs="http://calendarserver.org/ns/"
            xmlns:ic="http://apple.com/ns/ical/">
  <d:prop>
    <d:displayname/>
    <d:resourcetype/>
    <d:current-user-privilege-set/>
    <d:owner/>
    <c:supported-calendar-component-set/>
    <cs:getctag/>
    <ic:calendar-color/>
  </d:prop>
</d:propfind>`;

async function findPrincipal(user, pw) {
  // Try well-known first, then the bare root.
  const candidates = [
    `${ICLOUD_CALDAV}/.well-known/caldav`,
    `${ICLOUD_CALDAV}/`
  ];
  for (const url of candidates) {
    const r = await dav('PROPFIND', url, { user, pw, body: PROP_PRINCIPAL, depth: '0' });
    if (!r.ok) continue;
    const href = xmlOne(xmlOne(r.text, 'current-user-principal'), 'href');
    if (href) return absoluteUrl(href, url);
  }
  return '';
}

async function findCalendarHome(principalUrl, user, pw) {
  const r = await dav('PROPFIND', principalUrl, { user, pw, body: PROP_HOME, depth: '0' });
  if (!r.ok) return '';
  const href = xmlOne(xmlOne(r.text, 'calendar-home-set'), 'href');
  return absoluteUrl(href, principalUrl);
}

/**
 * Discover every calendar and reminder list the account can see.
 *
 * Returns { ok, error, sources: [ {...} ] } where each source is:
 *   id            stable key (the collection URL)
 *   url           collection URL
 *   name          display name, e.g. "Groceries"
 *   kind          'calendar' | 'reminders'
 *   sharedByOther true when the collection is owned by someone else
 *   readOnly      true when we lack write privilege
 *   color         hex, when Apple supplies it
 *   ctag          change tag — cheap way to detect "anything changed?"
 */
async function discover({ user, pw }) {
  if (!user || !pw) return { ok: false, error: 'iCloud credentials not configured', sources: [] };

  let principal;
  try {
    principal = await findPrincipal(user, pw);
  } catch (e) {
    return { ok: false, error: `principal lookup failed: ${e.message}`, sources: [] };
  }
  if (!principal) return { ok: false, error: 'could not find CalDAV principal (check the app-specific password)', sources: [] };

  const home = await findCalendarHome(principal, user, pw);
  if (!home) return { ok: false, error: 'could not find calendar home', sources: [] };

  const r = await dav('PROPFIND', home, { user, pw, body: PROP_COLLECTIONS, depth: '1' });
  if (!r.ok) return { ok: false, error: `collection listing failed (HTTP ${r.status})`, sources: [] };

  const principalPath = (() => { try { return new URL(principal).pathname; } catch { return principal; } })();

  const sources = [];
  for (const block of responses(r.text)) {
    const href = xmlOne(block, 'href');
    const url = absoluteUrl(href, home);
    if (!url || url.replace(/\/$/, '') === home.replace(/\/$/, '')) continue;

    const rtype = xmlOne(block, 'resourcetype');
    if (!xmlHasTag(rtype, 'calendar')) continue;

    const comps = xmlOne(block, 'supported-calendar-component-set');
    const supportsTodo = /VTODO/i.test(comps);
    const supportsEvent = /VEVENT/i.test(comps);
    // Apple returns an explicit component set; when absent, assume events.
    const kind = supportsTodo && !supportsEvent ? 'reminders' : 'calendar';

    const name = xmlText(xmlOne(block, 'displayname')) || url.split('/').filter(Boolean).pop();

    const privs = xmlOne(block, 'current-user-privilege-set');
    const canWrite = xmlHasTag(privs, 'write') || xmlHasTag(privs, 'write-content') || xmlHasTag(privs, 'all');

    const ownerHref = xmlText(xmlOne(xmlOne(block, 'owner'), 'href'));
    const sharedByOther = !!ownerHref && !!principalPath && !ownerHref.includes(principalPath.replace(/\/$/, ''));

    sources.push({
      id: url,
      url,
      name,
      kind,
      sharedByOther,
      readOnly: !canWrite,
      color: xmlText(xmlOne(block, 'calendar-color')) || '',
      ctag: xmlText(xmlOne(block, 'getctag')) || ''
    });
  }

  sources.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'calendar' ? -1 : 1));
  return { ok: true, error: '', principal, home, sources };
}

/* ---------------------------------------------------------------------------
 * 4. ICALENDAR PARSING
 *
 * Enough of RFC 5545 to be correct for the shapes Apple and Geeks2U emit:
 * line unfolding, escaped text, DATE vs DATE-TIME, floating vs UTC vs TZID,
 * VEVENT and VTODO. Recurrence is read (RRULE preserved) but not expanded —
 * see expandRecurring() for the narrow expansion we do want.
 * ------------------------------------------------------------------------ */

function unfold(ics) {
  // RFC 5545 line folding: CRLF followed by a single space or tab.
  return String(ics || '').replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
}

function unescapeIcs(v) {
  return String(v || '')
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

function escapeIcs(v) {
  return String(v || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

function parseIcsDate(value, params = {}) {
  const v = String(value || '').trim();
  if (!v) return null;

  // DATE form: 20260720
  if (/^\d{8}$/.test(v)) {
    const y = +v.slice(0, 4), mo = +v.slice(4, 6) - 1, d = +v.slice(6, 8);
    return { date: new Date(Date.UTC(y, mo, d)), allDay: true, floating: false };
  }
  // DATE-TIME: 20260720T093000 or ...Z
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(v);
  if (m) {
    const [, y, mo, d, h, mi, s, z] = m;
    if (z) {
      return { date: new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)), allDay: false, floating: false };
    }
    // TZID or floating. We keep the wall-clock components and treat them as
    // local to the server's configured zone — the caller formats for display,
    // and Vision runs one user in one place, so this is honest and stable.
    return {
      date: new Date(+y, +mo - 1, +d, +h, +mi, +s),
      allDay: false,
      floating: !params.TZID,
      tzid: params.TZID || ''
    };
  }
  const fallback = new Date(v);
  return isNaN(fallback) ? null : { date: fallback, allDay: false, floating: false };
}

function parseLine(line) {
  const idx = line.indexOf(':');
  if (idx === -1) return null;
  const left = line.slice(0, idx);
  const value = line.slice(idx + 1);
  const parts = left.split(';');
  const name = parts[0].toUpperCase();
  const params = {};
  for (let i = 1; i < parts.length; i++) {
    const eq = parts[i].indexOf('=');
    if (eq === -1) continue;
    params[parts[i].slice(0, eq).toUpperCase()] = parts[i].slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name, params, value };
}

/**
 * Parse an iCalendar payload into events and todos.
 * Returns { events: [], todos: [] }
 */
function parseIcs(raw) {
  const lines = unfold(raw).split(/\r?\n/);
  const events = [];
  const todos = [];

  let cur = null;
  let type = null;

  for (const line of lines) {
    if (!line) continue;
    const up = line.toUpperCase();

    if (up.startsWith('BEGIN:VEVENT')) { cur = { raw: [] }; type = 'event'; continue; }
    if (up.startsWith('BEGIN:VTODO')) { cur = { raw: [] }; type = 'todo'; continue; }
    if (up.startsWith('END:VEVENT') || up.startsWith('END:VTODO')) {
      if (cur) {
        if (type === 'event') events.push(finishEvent(cur));
        else todos.push(finishTodo(cur));
      }
      cur = null; type = null; continue;
    }
    if (!cur) continue;

    const p = parseLine(line);
    if (!p) continue;
    cur.raw.push(line);

    switch (p.name) {
      case 'UID': cur.uid = p.value.trim(); break;
      case 'SUMMARY': cur.summary = unescapeIcs(p.value); break;
      case 'DESCRIPTION': cur.description = unescapeIcs(p.value); break;
      case 'LOCATION': cur.location = unescapeIcs(p.value); break;
      case 'STATUS': cur.status = p.value.trim().toUpperCase(); break;
      case 'DTSTART': cur.start = parseIcsDate(p.value, p.params); break;
      case 'DTEND': cur.end = parseIcsDate(p.value, p.params); break;
      case 'DUE': cur.due = parseIcsDate(p.value, p.params); break;
      case 'COMPLETED': cur.completed = parseIcsDate(p.value, p.params); break;
      case 'RRULE': cur.rrule = p.value.trim(); break;
      case 'PRIORITY': cur.priority = parseInt(p.value, 10) || 0; break;
      case 'SEQUENCE': cur.sequence = parseInt(p.value, 10) || 0; break;
      case 'LAST-MODIFIED': cur.lastModified = parseIcsDate(p.value, p.params); break;
      case 'RELATED-TO': cur.parent = p.value.trim(); break;
      default: break;
    }
  }

  return { events, todos };
}

function finishEvent(c) {
  return {
    uid: c.uid || '',
    title: c.summary || '(untitled)',
    description: c.description || '',
    location: c.location || '',
    start: c.start ? c.start.date : null,
    end: c.end ? c.end.date : null,
    allDay: !!(c.start && c.start.allDay),
    rrule: c.rrule || '',
    status: c.status || '',
    lastModified: c.lastModified ? c.lastModified.date : null,
    sequence: c.sequence || 0
  };
}

function finishTodo(c) {
  const done = c.status === 'COMPLETED' || !!c.completed;
  return {
    uid: c.uid || '',
    title: c.summary || '(untitled)',
    notes: c.description || '',
    due: c.due ? c.due.date : null,
    dueAllDay: !!(c.due && c.due.allDay),
    completed: done,
    completedAt: c.completed ? c.completed.date : null,
    priority: c.priority || 0,
    parent: c.parent || '',
    status: c.status || ''
  };
}

/* ---------------------------------------------------------------------------
 * 5. RECURRENCE — narrow expansion
 *
 * Full RRULE is a swamp. What Vision actually needs is: "does this recurring
 * thing land inside the window I'm about to speak?" So we expand only the
 * common frequencies over a bounded window and stop. Anything exotic is
 * returned as-is with a flag rather than silently dropped or wrongly placed.
 * ------------------------------------------------------------------------ */

const DAY_INDEX = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

function parseRrule(rrule) {
  const out = {};
  for (const part of String(rrule || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    out[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1);
  }
  return out;
}

function expandRecurring(event, windowStart, windowEnd, cap = 60) {
  if (!event.rrule || !event.start) return event.start ? [event] : [];

  const r = parseRrule(event.rrule);
  const freq = (r.FREQ || '').toUpperCase();
  const interval = Math.max(1, parseInt(r.INTERVAL, 10) || 1);
  const until = r.UNTIL ? (parseIcsDate(r.UNTIL) || {}).date : null;
  const count = r.COUNT ? parseInt(r.COUNT, 10) : null;
  const byday = r.BYDAY ? r.BYDAY.split(',').map(s => s.slice(-2).toUpperCase()) : null;

  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) {
    return [{ ...event, recurringUnsupported: true }];
  }

  const durationMs = event.end && event.start ? (event.end - event.start) : 0;
  const out = [];
  let cursor = new Date(event.start);
  let emitted = 0;
  let guard = 0;

  while (guard++ < 2000 && out.length < cap) {
    if (until && cursor > until) break;
    if (count !== null && emitted >= count) break;
    if (cursor > windowEnd) break;

    const matchesDay = !byday || byday.includes(Object.keys(DAY_INDEX).find(k => DAY_INDEX[k] === cursor.getDay()));
    if (cursor >= windowStart && matchesDay) {
      out.push({
        ...event,
        start: new Date(cursor),
        end: durationMs ? new Date(cursor.getTime() + durationMs) : null,
        recurringInstance: true
      });
    }
    if (matchesDay) emitted++;

    const next = new Date(cursor);
    if (freq === 'DAILY') next.setDate(next.getDate() + interval);
    else if (freq === 'WEEKLY') next.setDate(next.getDate() + (byday ? 1 : 7 * interval));
    else if (freq === 'MONTHLY') next.setMonth(next.getMonth() + interval);
    else next.setFullYear(next.getFullYear() + interval);
    cursor = next;
  }

  return out;
}

/* ---------------------------------------------------------------------------
 * 6. READING
 * ------------------------------------------------------------------------ */

function icsStamp(d, allDay = false) {
  const p = n => String(n).padStart(2, '0');
  if (allDay) return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function calendarQueryBody(kind, from, to) {
  if (kind === 'reminders') {
    return `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:getetag/><c:calendar-data/></d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VTODO"/>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`;
  }
  return `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:getetag/><c:calendar-data/></d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">
        <c:time-range start="${icsStamp(from)}" end="${icsStamp(to)}"/>
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`;
}

/**
 * Read events from one calendar collection between two dates.
 * Recurring events are expanded into the window.
 */
async function readEvents(source, { user, pw, from, to }) {
  const start = from || new Date();
  const end = to || new Date(Date.now() + 14 * 864e5);

  const r = await dav('REPORT', source.url, {
    user, pw,
    body: calendarQueryBody('calendar', start, end),
    depth: '1'
  });
  if (!r.ok) return { ok: false, error: `HTTP ${r.status}`, events: [] };

  const events = [];
  for (const block of responses(r.text)) {
    const data = xmlText(xmlOne(block, 'calendar-data'));
    if (!data) continue;
    const href = absoluteUrl(xmlOne(block, 'href'), source.url);
    const etag = xmlText(xmlOne(block, 'getetag'));
    const parsed = parseIcs(data);
    for (const ev of parsed.events) {
      const instances = ev.rrule ? expandRecurring(ev, start, end) : (ev.start ? [ev] : []);
      for (const inst of instances) {
        if (inst.start && inst.start >= start && inst.start <= end) {
          events.push({ ...inst, href, etag, sourceId: source.id, sourceName: source.name, sharedByOther: source.sharedByOther });
        }
      }
    }
  }

  events.sort((a, b) => (a.start || 0) - (b.start || 0));
  return { ok: true, error: '', events };
}

/**
 * Read todos from one reminder list.
 * includeCompleted defaults false — a 105-item list is mostly noise otherwise.
 * limit caps what comes back; Peptides/vitamins is the reason this exists.
 */
async function readTodos(source, { user, pw, includeCompleted = false, limit = 200 }) {
  const r = await dav('REPORT', source.url, {
    user, pw,
    body: calendarQueryBody('reminders'),
    depth: '1'
  });
  if (!r.ok) return { ok: false, error: `HTTP ${r.status}`, todos: [], total: 0 };

  const todos = [];
  for (const block of responses(r.text)) {
    const data = xmlText(xmlOne(block, 'calendar-data'));
    if (!data) continue;
    const href = absoluteUrl(xmlOne(block, 'href'), source.url);
    const etag = xmlText(xmlOne(block, 'getetag'));
    for (const t of parseIcs(data).todos) {
      if (!includeCompleted && t.completed) continue;
      todos.push({ ...t, href, etag, raw: data, sourceId: source.id, sourceName: source.name, sharedByOther: source.sharedByOther });
    }
  }

  const total = todos.length;
  todos.sort((a, b) => {
    if (a.due && b.due) return a.due - b.due;
    if (a.due) return -1;
    if (b.due) return 1;
    return (b.priority || 0) - (a.priority || 0);
  });

  return { ok: true, error: '', todos: todos.slice(0, limit), total, truncated: total > limit };
}

/* ---------------------------------------------------------------------------
 * 7. ICS SUBSCRIPTION FEEDS (Geeks2U)
 *
 * A plain GET. No auth — the URL itself is the credential, which is why it
 * belongs in an env var and not the repo. Polling this directly means Vision
 * sees new jobs on ITS schedule rather than waiting for Apple to refresh.
 * ------------------------------------------------------------------------ */

async function readIcsFeed(url, { from, to, name = 'Subscribed' } = {}) {
  if (!url) return { ok: false, error: 'no feed URL configured', events: [] };
  const start = from || new Date();
  const end = to || new Date(Date.now() + 14 * 864e5);

  let res;
  try {
    res = await withTimeout(DAV_TIMEOUT_MS, signal =>
      fetch(url, { headers: { 'User-Agent': 'Vision/1.0', Accept: 'text/calendar, */*' }, signal }));
  } catch (e) {
    const timedOut = e && (e.name === 'AbortError' || /abort/i.test(String(e.message || '')));
    return { ok: false, error: timedOut ? `feed timed out after ${DAV_TIMEOUT_MS}ms` : `fetch failed: ${e.message}`, events: [] };
  }
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, events: [] };

  const raw = await res.text();
  if (!/BEGIN:VCALENDAR/i.test(raw)) {
    return { ok: false, error: 'response was not an iCalendar feed', events: [] };
  }

  const events = [];
  for (const ev of parseIcs(raw).events) {
    const instances = ev.rrule ? expandRecurring(ev, start, end) : (ev.start ? [ev] : []);
    for (const inst of instances) {
      if (inst.start && inst.start >= start && inst.start <= end) {
        events.push({ ...inst, sourceId: `ics:${url}`, sourceName: name, sharedByOther: false, readOnly: true });
      }
    }
  }
  events.sort((a, b) => (a.start || 0) - (b.start || 0));
  return { ok: true, error: '', events, count: events.length };
}

/* ---------------------------------------------------------------------------
 * 8. WRITING
 *
 * Every one of these is destructive-ish and several target lists shared with
 * Shaun's wife. They are written to be called ONLY after a spoken read-back
 * confirmation — see confirmationLine() below, which builds that sentence.
 * ------------------------------------------------------------------------ */

function newUid() {
  return `vision-${Date.now()}-${Math.random().toString(36).slice(2, 10)}@vision.local`;
}

function buildVtodo({ uid, title, notes, due, dueAllDay, completed, priority }) {
  const now = icsStamp(new Date());
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Vision//EN',
    'BEGIN:VTODO',
    `UID:${uid}`,
    `DTSTAMP:${now}`,
    `SUMMARY:${escapeIcs(title)}`
  ];
  if (notes) lines.push(`DESCRIPTION:${escapeIcs(notes)}`);
  if (due) lines.push(dueAllDay ? `DUE;VALUE=DATE:${icsStamp(due, true)}` : `DUE:${icsStamp(due)}`);
  if (priority) lines.push(`PRIORITY:${priority}`);
  if (completed) {
    lines.push('STATUS:COMPLETED');
    lines.push('PERCENT-COMPLETE:100');
    lines.push(`COMPLETED:${now}`);
  }
  lines.push('END:VTODO', 'END:VCALENDAR');
  return lines.join('\r\n');
}

/**
 * Mark an existing todo complete.
 * Rewrites the original iCalendar object rather than synthesising a new one,
 * so notes, due dates, subtasks and anything else Apple stored survive.
 */
async function completeTodo(todo, { user, pw }) {
  if (!todo || !todo.href) return { ok: false, error: 'missing todo reference' };

  let body;
  if (todo.raw && /BEGIN:VTODO/i.test(todo.raw)) {
    const now = icsStamp(new Date());
    body = unfold(todo.raw)
      .replace(/^STATUS:.*$/gim, '')
      .replace(/^PERCENT-COMPLETE:.*$/gim, '')
      .replace(/^COMPLETED:.*$/gim, '')
      .split(/\r?\n/).filter(Boolean)
      .join('\r\n')
      .replace(/END:VTODO/i, `STATUS:COMPLETED\r\nPERCENT-COMPLETE:100\r\nCOMPLETED:${now}\r\nEND:VTODO`);
  } else {
    body = buildVtodo({ ...todo, uid: todo.uid || newUid(), completed: true });
  }

  const r = await dav('PUT', todo.href, {
    user, pw, body,
    contentType: 'text/calendar; charset=utf-8',
    extraHeaders: todo.etag ? { 'If-Match': todo.etag } : {}
  });

  if (r.status === 412) return { ok: false, error: 'changed on another device — re-read the list and try again', conflict: true };
  if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
  return { ok: true };
}

/** Add a new item to a reminder list. */
async function addTodo(source, { user, pw, title, notes, due, dueAllDay = true }) {
  if (!source || source.readOnly) return { ok: false, error: 'that list is read-only' };
  if (!title || !title.trim()) return { ok: false, error: 'nothing to add' };

  const uid = newUid();
  const url = source.url.replace(/\/$/, '') + '/' + encodeURIComponent(uid.split('@')[0]) + '.ics';
  const body = buildVtodo({ uid, title: title.trim(), notes, due, dueAllDay });

  const r = await dav('PUT', url, {
    user, pw, body,
    contentType: 'text/calendar; charset=utf-8',
    extraHeaders: { 'If-None-Match': '*' }
  });
  if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
  return { ok: true, uid, href: url };
}

/** Create a calendar event. */
async function createEvent(source, { user, pw, title, start, end, location, notes, allDay = false }) {
  if (!source || source.readOnly) return { ok: false, error: 'that calendar is read-only' };
  if (!title || !start) return { ok: false, error: 'need a title and a start time' };

  const uid = newUid();
  const url = source.url.replace(/\/$/, '') + '/' + encodeURIComponent(uid.split('@')[0]) + '.ics';
  const finish = end || new Date(start.getTime() + 60 * 60 * 1000);
  const now = icsStamp(new Date());

  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Vision//EN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${now}`,
    allDay ? `DTSTART;VALUE=DATE:${icsStamp(start, true)}` : `DTSTART:${icsStamp(start)}`,
    allDay ? `DTEND;VALUE=DATE:${icsStamp(finish, true)}` : `DTEND:${icsStamp(finish)}`,
    `SUMMARY:${escapeIcs(title)}`
  ];
  if (location) lines.push(`LOCATION:${escapeIcs(location)}`);
  if (notes) lines.push(`DESCRIPTION:${escapeIcs(notes)}`);
  lines.push('END:VEVENT', 'END:VCALENDAR');

  const r = await dav('PUT', url, {
    user, pw, body: lines.join('\r\n'),
    contentType: 'text/calendar; charset=utf-8',
    extraHeaders: { 'If-None-Match': '*' }
  });
  if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
  return { ok: true, uid, href: url };
}

/* ---------------------------------------------------------------------------
 * 9. FUZZY MATCHING
 *
 * Two distinct problems, deliberately tuned differently:
 *
 *   matchList()  – "to do" is ambiguous across THREE of Shaun's lists
 *                  ("Things To Do Shaun", "To do", "Things To Do For Working
 *                  Oversees"). So this returns candidates and refuses to guess.
 *
 *   matchItems() – "milk" should find "2L full cream milk", but must not tick
 *                  the wrong thing. Confident matches only; anything close
 *                  goes back as a question.
 * ------------------------------------------------------------------------ */

function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function tokens(s) {
  return norm(s).split(' ').filter(Boolean);
}

function similarity(a, b) {
  const A = norm(a), B = norm(b);
  if (!A || !B) return 0;
  if (A === B) return 1;

  const ta = tokens(A), tb = tokens(B);
  const setB = new Set(tb);
  const setA = new Set(ta);

  // How much of the SPOKEN phrase is present in the candidate, and vice versa.
  const inB = ta.filter(t => setB.has(t)).length / ta.length;
  const inA = tb.filter(t => setA.has(t)).length / tb.length;

  // Every spoken word present in the candidate is a strong signal even when
  // the candidate has extra words: "bread" -> "Sourdough bread".
  // Harmonic-ish blend, weighted toward covering the spoken phrase.
  const tokenScore = inB === 0 ? 0 : (0.75 * inB + 0.25 * inA);

  // Whole-phrase substring, e.g. "almond milk" inside "Almond milk 1L"
  let sub = 0;
  if (B.includes(A)) sub = 0.7 + 0.3 * (A.length / B.length);
  else if (A.includes(B)) sub = 0.7 + 0.3 * (B.length / A.length);

  // Singular/plural forgiveness: banana -> bananas
  let stemBonus = 0;
  for (const t of ta) {
    for (const u of tb) {
      if (t === u) continue;
      if (t.length > 3 && (u === t + 's' || t === u + 's' || u === t + 'es' || t === u + 'es')) {
        stemBonus = Math.max(stemBonus, 0.85 / Math.max(ta.length, 1));
      }
    }
  }

  return Math.min(1, Math.max(tokenScore + stemBonus, sub));
}

/**
 * Resolve a spoken list name to a source.
 * Returns { status: 'match'|'ambiguous'|'none', source, candidates }
 */
function matchList(spoken, sources, kind = null) {
  const pool = kind ? sources.filter(s => s.kind === kind) : sources;
  const scored = pool
    .map(s => ({ source: s, score: similarity(spoken, s.name) }))
    .filter(x => x.score > 0.34)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) return { status: 'none', source: null, candidates: [] };

  const top = scored[0];
  const runnerUp = scored[1];
  const spokenNorm = norm(spoken);

  // How many DIFFERENT lists contain the spoken phrase outright? Shaun has
  // three lists containing "to do", so an exact hit on one of them is still
  // genuinely ambiguous out loud — ask instead of picking the shortest.
  const containing = pool.filter(s => norm(s.name).includes(spokenNorm));
  if (containing.length > 1) {
    return { status: 'ambiguous', source: null, candidates: containing.slice(0, 4) };
  }

  // Unambiguous exact match wins outright.
  if (norm(top.source.name) === spokenNorm) {
    return { status: 'match', source: top.source, candidates: [] };
  }
  // Too close to call — ask rather than guess.
  if (runnerUp && (top.score - runnerUp.score) < 0.18) {
    return { status: 'ambiguous', source: null, candidates: scored.slice(0, 4).map(x => x.source) };
  }
  if (top.score >= 0.6) return { status: 'match', source: top.source, candidates: [] };
  return { status: 'ambiguous', source: null, candidates: scored.slice(0, 4).map(x => x.source) };
}

/**
 * Match spoken item names against a list's todos.
 * Returns { matched:[{spoken, todo}], ambiguous:[{spoken, options}], missing:[spoken] }
 */
function matchItems(spokenItems, todos) {
  const matched = [], ambiguous = [], missing = [];
  const taken = new Set();

  for (const spoken of spokenItems) {
    const scored = todos
      .filter(t => !taken.has(t.uid))
      .map(t => ({ todo: t, score: similarity(spoken, t.title) }))
      .filter(x => x.score > 0.34)
      .sort((a, b) => b.score - a.score);

    if (!scored.length) { missing.push(spoken); continue; }

    const top = scored[0], next = scored[1];
    const confident = top.score >= 0.72 && (!next || top.score - next.score >= 0.2);

    if (confident) {
      taken.add(top.todo.uid);
      matched.push({ spoken, todo: top.todo });
    } else {
      ambiguous.push({ spoken, options: scored.slice(0, 3).map(x => x.todo) });
    }
  }

  return { matched, ambiguous, missing };
}

/**
 * Split "banana done, milk done and bread" into ['banana','milk','bread'].
 * Handles the natural ways this gets said out loud.
 */
function parseSpokenItems(utterance) {
  return String(utterance || '')
    .replace(/\b(tick|check|cross|mark|scratch)\s+(off|out)\b/gi, ',')
    .replace(/\bgot it\b/gi, ',')
    .replace(/\b(is|are|as)?\s*(done|complete|completed|finished|bought)\b/gi, ',')
    .replace(/\bpicked up\b/gi, ',')
    .split(/,|\band\b|\balso\b|\bplus\b/i)
    // Leading verbs and articles are noise: "got the milk" -> "milk"
    .map(s => s
      .replace(/^\s*(i\s+)?(got|grabbed|have|had|bought|picked|took|did)\b/i, '')
      .replace(/^\s*(up|off|out)\b/i, '')
      .replace(/^\s*(the|a|an|some|my|our)\s+/i, '')
      .trim())
    .filter(s => s && s.length > 1 && !/^(off|out|it|that|those|them|up)$/i.test(s));
}

/* ---------------------------------------------------------------------------
 * 10. READ-BACK CONFIRMATION
 *
 * Four of Shaun's lists are his wife's and two are shared out by him, so a
 * mis-parsed tick becomes someone else's problem. Nothing writes without one
 * of these sentences being spoken and answered first.
 * ------------------------------------------------------------------------ */

function confirmationLine(action, detail) {
  switch (action) {
    case 'tick': {
      const names = detail.items.map(i => i.todo.title);
      const list = names.length === 1 ? names[0]
        : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
      const shared = detail.source && detail.source.sharedByOther ? ` on the shared ${detail.source.name} list` : ` off ${detail.source.name}`;
      return `Ticking ${list}${shared}. Right?`;
    }
    case 'add':
      return `Adding "${detail.title}" to ${detail.source.name}${detail.source.sharedByOther ? ' — that one\'s shared' : ''}. Right?`;
    case 'event': {
      const when = detail.start ? detail.start.toLocaleString('en-AU', { weekday: 'long', hour: 'numeric', minute: '2-digit', hour12: true }) : '';
      return `Putting "${detail.title}" in ${detail.source.name} for ${when}. Right?`;
    }
    default:
      return 'Go ahead?';
  }
}

/* ---------------------------------------------------------------------------
 * 11. PICKER — per-source read / monitor toggles
 *
 * Two independent switches per source, exactly as agreed:
 *   read    – Vision can see it when asked
 *   monitor – the watcher polls it and it may lead the brief
 *
 * Both off = ignored entirely. New sources default to OFF so a list created
 * next month never starts talking on its own.
 * ------------------------------------------------------------------------ */

const DEFAULT_PREFS = { read: false, monitor: false };

function mergePrefs(sources, saved = {}) {
  return sources.map(s => ({
    ...s,
    read: saved[s.id] ? !!saved[s.id].read : DEFAULT_PREFS.read,
    monitor: saved[s.id] ? !!saved[s.id].monitor : DEFAULT_PREFS.monitor
  }));
}

function readable(sources) { return sources.filter(s => s.read || s.monitor); }
function monitored(sources) { return sources.filter(s => s.monitor); }

/* ---------------------------------------------------------------------------
 * 12. BRIEF BUILDING + CHANGE DETECTION
 * ------------------------------------------------------------------------ */

function startOfDay(d = new Date()) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function endOfDay(d = new Date()) { const x = new Date(d); x.setHours(23, 59, 59, 999); return x; }

function timeWord(d, allDay) {
  if (allDay) return 'all day';
  return d.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit', hour12: true }).replace(':00', '');
}

/**
 * Build the spoken day summary. Shared calendars are attributed rather than
 * jumbled in — "she's got Gracie's thing at two", not a flat list.
 */
function buildDayBrief(events, todos, { now = new Date() } = {}) {
  const today = events.filter(e => e.start >= startOfDay(now) && e.start <= endOfDay(now));
  const upcoming = today.filter(e => e.allDay || e.start >= now);
  // Overdue and due-today are mutually exclusive — an item yesterday is
  // overdue, not "due today", or it gets announced twice.
  const overdue = todos.filter(t => t.due && t.due < startOfDay(now) && !t.completed);
  const dueToday = todos.filter(t => t.due && t.due >= startOfDay(now) && t.due <= endOfDay(now) && !t.completed);

  const parts = [];

  if (overdue.length) {
    parts.push(overdue.length === 1
      ? `${overdue[0].title} is overdue on ${overdue[0].sourceName}.`
      : `${overdue.length} overdue items, oldest is ${overdue[0].title}.`);
  }

  if (!upcoming.length) {
    parts.push('Nothing left in the calendar today.');
  } else {
    const mine = upcoming.filter(e => !e.sharedByOther);
    const theirs = upcoming.filter(e => e.sharedByOther);
    if (mine.length) {
      parts.push('You\'ve got ' + mine.map(e => `${e.title} at ${timeWord(e.start, e.allDay)}`).join(', ') + '.');
    }
    if (theirs.length) {
      parts.push('On the shared calendars: ' + theirs.map(e => `${e.title} at ${timeWord(e.start, e.allDay)}`).join(', ') + '.');
    }
  }

  if (dueToday.length) {
    parts.push(dueToday.length === 1
      ? `${dueToday[0].title} is due today.`
      : `${dueToday.length} things due today, including ${dueToday[0].title}.`);
  }

  return {
    spoken: parts.join(' '),
    counts: { events: upcoming.length, dueToday: dueToday.length, overdue: overdue.length },
    events: upcoming,
    dueToday,
    overdue
  };
}

/**
 * Diff a fresh read against the previously seen state.
 * Returns things worth leading with next time Vision is opened.
 */
function detectChanges(fresh, seen = {}) {
  const added = [], moved = [], removed = [];
  const freshById = {};

  for (const e of fresh) {
    const key = e.uid + '|' + (e.start ? e.start.toISOString() : '');
    freshById[key] = e;
    const prior = seen[e.uid];
    if (!prior) { added.push(e); continue; }
    if (prior.start && e.start && prior.start !== e.start.toISOString()) moved.push({ event: e, was: prior.start });
  }

  for (const uid of Object.keys(seen)) {
    if (!fresh.some(e => e.uid === uid)) removed.push(seen[uid]);
  }

  const nextSeen = {};
  for (const e of fresh) {
    nextSeen[e.uid] = { title: e.title, start: e.start ? e.start.toISOString() : null, sourceName: e.sourceName };
  }

  return { added, moved, removed, nextSeen, any: !!(added.length || moved.length || removed.length) };
}

function changesToSpoken(changes) {
  const bits = [];
  for (const e of changes.added) {
    bits.push(`New: ${e.title}, ${e.start ? e.start.toLocaleString('en-AU', { weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: true }) : 'no time'}${e.sharedByOther ? ` on ${e.sourceName}` : ''}.`);
  }
  for (const m of changes.moved) {
    bits.push(`${m.event.title} moved to ${m.event.start.toLocaleString('en-AU', { weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: true })}.`);
  }
  for (const r of changes.removed) {
    bits.push(`${r.title} was cancelled.`);
  }
  return bits.join(' ');
}

/* ---------------------------------------------------------------------------
 * 13. FREE/BUSY — for the planner
 *
 * The single biggest upgrade here: plans stop being proposed into a void.
 * ------------------------------------------------------------------------ */

function busyBlocks(events) {
  return events
    .filter(e => !e.allDay && e.start && e.end)
    .map(e => ({ start: e.start, end: e.end, title: e.title, sourceName: e.sourceName }))
    .sort((a, b) => a.start - b.start);
}

function isFree(events, start, end) {
  const clashes = busyBlocks(events).filter(b => b.start < end && b.end > start);
  return { free: clashes.length === 0, clashes };
}

/**
 * Find open slots of a given length inside working hours.
 */
function findSlots(events, { from, to, minutes = 60, dayStart = 8, dayEnd = 18, max = 5 }) {
  const busy = busyBlocks(events);
  const slots = [];
  const cursor = new Date(from);

  while (cursor < to && slots.length < max) {
    const dayFloor = new Date(cursor); dayFloor.setHours(dayStart, 0, 0, 0);
    const dayCeil = new Date(cursor); dayCeil.setHours(dayEnd, 0, 0, 0);
    let probe = cursor < dayFloor ? dayFloor : new Date(cursor);

    while (probe < dayCeil && slots.length < max) {
      const end = new Date(probe.getTime() + minutes * 60000);
      if (end > dayCeil) break;
      const clash = busy.find(b => b.start < end && b.end > probe);
      if (!clash) {
        slots.push({ start: new Date(probe), end });
        probe = new Date(end);
      } else {
        probe = new Date(clash.end);
      }
    }
    cursor.setDate(cursor.getDate() + 1);
    cursor.setHours(0, 0, 0, 0);
  }
  return slots;
}

/* ---------------------------------------------------------------------------
 * 14. RECURRING PATTERN DETECTION
 *
 * Needs weeks of history before it says anything useful — it is deliberately
 * quiet rather than confidently wrong on day one.
 * ------------------------------------------------------------------------ */

function detectPatterns(history, { minOccurrences = 3 } = {}) {
  const byTitle = {};
  for (const h of history) {
    const key = norm(h.title);
    if (!key) continue;
    (byTitle[key] = byTitle[key] || []).push(new Date(h.start || h.completedAt));
  }

  const patterns = [];
  for (const [key, dates] of Object.entries(byTitle)) {
    if (dates.length < minOccurrences) continue;
    dates.sort((a, b) => a - b);

    const gaps = [];
    for (let i = 1; i < dates.length; i++) gaps.push((dates[i] - dates[i - 1]) / 864e5);
    const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const spread = Math.max(...gaps) - Math.min(...gaps);
    if (spread > avg * 0.5) continue; // too irregular to claim a pattern

    const dow = dates.map(d => d.getDay());
    const sameDay = dow.every(d => d === dow[0]);

    patterns.push({
      title: key,
      occurrences: dates.length,
      averageGapDays: Math.round(avg),
      weekday: sameDay ? ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][dow[0]] : null,
      lastSeen: dates[dates.length - 1],
      nextExpected: new Date(dates[dates.length - 1].getTime() + avg * 864e5),
      confidence: Math.min(1, dates.length / 6)
    });
  }

  return patterns.sort((a, b) => b.confidence - a.confidence);
}

/* ---------------------------------------------------------------------------
 * 15. MEMORY LINES
 *
 * Calendar and list facts are TOOL-SOURCED, not things Shaun said. They are
 * tagged so a stale calendar entry can never outrank something he actually
 * told Vision.
 * ------------------------------------------------------------------------ */

function memoryLineForEvent(e) {
  const when = e.start ? e.start.toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }) : 'no time';
  return {
    text: `calendar: ${e.title}${e.location ? ' at ' + e.location : ''} — ${when}${e.sharedByOther ? ` (${e.sourceName}, shared)` : ''}`,
    origin: 'tool',
    kind: 'calendar',
    sourceName: e.sourceName,
    at: e.start || null
  };
}

function memoryLineForCompletion(todo) {
  return {
    text: `ticked off: ${todo.title} (${todo.sourceName})`,
    origin: 'tool',
    kind: 'reminder-complete',
    sourceName: todo.sourceName,
    at: new Date()
  };
}

/* ---------------------------------------------------------------------------
 * 16. HIGH-LEVEL ORCHESTRATION
 * ------------------------------------------------------------------------ */

/** One call that gathers everything monitored/readable across all sources. */
async function gather(sources, { user, pw, from, to, icsFeeds = [], includeCompleted = false, todoLimit = 200 }) {
  const start = from || startOfDay();
  const end = to || new Date(Date.now() + 14 * 864e5);

  const cals = sources.filter(s => s.kind === 'calendar');
  const lists = sources.filter(s => s.kind === 'reminders');

  const results = await Promise.allSettled([
    ...cals.map(s => readEvents(s, { user, pw, from: start, to: end })),
    ...lists.map(s => readTodos(s, { user, pw, includeCompleted, limit: todoLimit })),
    ...icsFeeds.map(f => readIcsFeed(f.url, { from: start, to: end, name: f.name }))
  ]);

  const events = [], todos = [], errors = [];
  for (const r of results) {
    if (r.status !== 'fulfilled') { errors.push(String(r.reason && r.reason.message || r.reason)); continue; }
    const v = r.value;
    if (!v.ok) { errors.push(v.error); continue; }
    if (v.events) events.push(...v.events);
    if (v.todos) todos.push(...v.todos);
  }

  events.sort((a, b) => (a.start || 0) - (b.start || 0));
  return { events, todos, errors };
}

/**
 * Prepare a tick-off. Does NOT write — returns what would happen plus the
 * confirmation sentence to speak. Call completeTodo() on each matched item
 * only after the user says yes.
 */
async function prepareTickOff(utterance, source, { user, pw }) {
  const spokenItems = parseSpokenItems(utterance);
  if (!spokenItems.length) return { ok: false, error: 'I didn\'t catch which items.' };
  if (source.readOnly) return { ok: false, error: `${source.name} is read-only.` };

  const listRead = await readTodos(source, { user, pw, includeCompleted: false, limit: 500 });
  if (!listRead.ok) return { ok: false, error: listRead.error };

  const m = matchItems(spokenItems, listRead.todos);
  if (!m.matched.length) {
    return {
      ok: false,
      error: m.missing.length
        ? `I couldn't find ${m.missing.join(' or ')} on ${source.name}.`
        : 'Nothing matched confidently.',
      ambiguous: m.ambiguous,
      missing: m.missing
    };
  }

  return {
    ok: true,
    needsConfirmation: true,
    confirm: confirmationLine('tick', { items: m.matched, source }),
    items: m.matched,
    ambiguous: m.ambiguous,
    missing: m.missing,
    source
  };
}

module.exports = {
  // discovery
  discover,
  // reading
  readEvents, readTodos, readIcsFeed, gather,
  // writing (always confirm first)
  completeTodo, addTodo, createEvent, prepareTickOff,
  // matching
  matchList, matchItems, parseSpokenItems, similarity,
  // confirmation
  confirmationLine,
  // picker
  mergePrefs, readable, monitored, DEFAULT_PREFS,
  // brief + changes
  buildDayBrief, detectChanges, changesToSpoken,
  // planner
  isFree, findSlots, busyBlocks,
  // patterns
  detectPatterns,
  // memory
  memoryLineForEvent, memoryLineForCompletion,
  // parsing internals (exported for tests)
  parseIcs, expandRecurring, startOfDay, endOfDay
};
