/** Tiny date helpers. All dates are ISO "YYYY-MM-DD" strings handled in UTC. */
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function isIsoDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function weekday(iso) {
  if (!isIsoDate(iso)) return null;
  return DAYS[new Date(iso + 'T00:00:00Z').getUTCDay()];
}

export const isWeekend = (iso) => ['Saturday', 'Sunday'].includes(weekday(iso));

export function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** ["2026-09-14 Mon", ...] for `days` days starting at `startIso` - gives the LLMs a reliable calendar. */
export function calendarHint(startIso, days = 60) {
  if (!isIsoDate(startIso)) return [];
  return Array.from({ length: days }, (_, i) => {
    const d = addDays(startIso, i);
    return `${d} ${weekday(d).slice(0, 3)}`;
  });
}
