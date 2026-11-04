// The watchdog's decisions, kept apart from the network so they can be tested: what a message asks for,
// whether a new health result is worth posting, and the words it posts.
import { formatHealth } from '../tools/health.mjs';

export const NAME = 'kv-watchdog';
export const HELP = [
  `I'm ${NAME}. I check thekartavya.com every few hours and post here when something changes, plus a summary each morning.`,
  `- \`@${NAME} check\` runs the checks now`,
  `- \`@${NAME} last\` shows the last result`,
  `When the site breaks I ask @kv-triager to open an incident ticket.`,
].join('\n');

export function parseCommand(body = '') {
  const text = body.replace(/@[\w.-]+/g, ' ').toLowerCase();
  if (/\b(check|health|status|up|down|now|run)\b/.test(text)) return 'check';
  if (/\b(last|latest|previous)\b/.test(text)) return 'last';
  return 'help';
}

const failing = h => new Map(h.checks.filter(c => !c.ok).map(c => [c.name, c.severity]));

// was anything fixed or broken since the last result?
export function diffHealth(prev, next) {
  if (!prev) return { changed: true, first: true, broke: [...failing(next)].filter(([, s]) => s === 'critical').map(([n]) => n), fixed: [] };
  const a = failing(prev), b = failing(next);
  const broke = [...b].filter(([n, s]) => s === 'critical' && a.get(n) !== 'critical').map(([n]) => n);
  const fixed = [...a].filter(([n]) => !b.has(n)).map(([n]) => n);
  const changed = prev.ok !== next.ok || a.size !== b.size || [...b].some(([n, s]) => a.get(n) !== s);
  return { changed, first: false, broke, fixed };
}

export function incidentMessage(h, broke) {
  const lines = h.checks.filter(c => !c.ok && c.severity === 'critical').map(c => `- ${c.name}: ${c.detail}`);
  return [
    `@kv-triager please open an incident ticket: ${broke.length === 1 ? broke[0] : `${broke.length} checks`} just started failing on ${h.base.replace(/^https?:\/\//, '')}.`,
    ...lines.slice(0, 6),
    'If this is hosting (Vercel, the domain, the certificate or AWS) and not code, tell the owner what to do.',
  ].join('\n');
}

export function changeMessage(h, d) {
  if (d.first) return `${NAME} is on duty. First look at the site:\n${formatHealth(h)}`;
  const head = d.fixed.length && h.ok ? `Back to normal. Fixed: ${d.fixed.join(', ')}.` : d.fixed.length ? `Better: ${d.fixed.join(', ')} fixed.` : 'Something changed on the site.';
  return `${head}\n${formatHealth(h)}`;
}

// the morning summary: once a day, at or after 09:00 India time
export function dailyDue(lastDay, now = new Date()) {
  const ist = new Date(now.getTime() + 5.5 * 3600 * 1000);
  const day = ist.toISOString().slice(0, 10);
  return ist.getUTCHours() >= 9 && day !== lastDay ? day : null;
}
