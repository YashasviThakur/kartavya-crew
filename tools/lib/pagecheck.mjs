// What the checker measures on a page, and how "before" (main) and "after" (the fix) are compared.
// The in-page functions are plain functions that are sent to Chrome as text, so they must not use
// anything from this module's scope.

// Runs in the page. Layout, search tags and images, as plain data.
export function pageMetrics(screenWidth) {
  // the device's own width: on a phone Chrome zooms a too-wide page out, so innerWidth would grow with the bug
  const W = screenWidth || innerWidth;
  const name = el => {
    let s = el.tagName.toLowerCase();
    if (el.id) return `${s}#${el.id}`;
    const c = [...el.classList].filter(x => !/^(is-|on$|in$|active|show)/.test(x)).slice(0, 2);
    return c.length ? `${s}.${c.join('.')}` : s;
  };
  const path = el => {
    const parts = [];
    for (let e = el; e && e !== document.body && parts.length < 4; e = e.parentElement) { parts.unshift(name(e)); if (e.id) break; }
    return parts.join(' > ');
  };
  const shown = el => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const insideScroller = el => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const o = getComputedStyle(p).overflowX;
      if (o !== 'visible') return true;
      if (getComputedStyle(p).position === 'fixed') return true;
    }
    return false;
  };
  // things sticking out past the right edge of the screen (the cause of sideways scrolling)
  const wideEls = new Set();
  for (const el of document.body.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (r.right > W + 2 && r.width > 0 && shown(el) && !insideScroller(el)) wideEls.add(el);
  }
  const wide = [...wideEls].filter(el => !wideEls.has(el.parentElement)).map(path);
  // words cut off inside their box
  const clipped = [];
  for (const el of document.body.querySelectorAll('h1,h2,h3,h4,h5,p,a,button,li,span,b,strong,small,label,td,th,dt,dd')) {
    if (!shown(el) || !el.textContent.trim() || el.clientWidth === 0) continue;
    const cs = getComputedStyle(el);
    const cut = (el.scrollWidth > el.clientWidth + 1 && (cs.overflowX !== 'visible' || cs.textOverflow === 'ellipsis'))
      || (el.scrollHeight > el.clientHeight + 2 && cs.overflowY === 'hidden' && cs.webkitLineClamp === 'none' && !['inline'].includes(cs.display));
    if (cut) clipped.push(path(el));
  }
  // tap targets smaller than a fingertip, on touch screens
  const small = [];
  if (W < 900) {
    for (const el of document.querySelectorAll('a[href],button,input:not([type=hidden]),select,textarea,[role=button]')) {
      if (!shown(el) || getComputedStyle(el).display === 'inline') continue;
      const r = el.getBoundingClientRect();
      if (r.width < 32 || r.height < 32) small.push(path(el));
    }
  }
  const imgs = [...document.images];
  const meta = n => document.querySelector(`meta[name="${n}"]`)?.content ?? null;
  return {
    width: W,
    overflowX: document.documentElement.scrollWidth > W + 1,
    scrollWidth: document.documentElement.scrollWidth,
    height: document.documentElement.scrollHeight,
    wide: [...new Set(wide)].slice(0, 15),
    clipped: [...new Set(clipped)].slice(0, 15),
    small: [...new Set(small)].slice(0, 15),
    broken: imgs.filter(i => i.complete && i.naturalWidth === 0 && shown(i)).map(i => i.currentSrc || i.getAttribute('src')).slice(0, 10),
    noAlt: imgs.filter(i => !i.hasAttribute('alt')).map(i => i.getAttribute('src')).slice(0, 10),
    head: {
      title: document.title || null,
      description: meta('description'),
      canonical: document.querySelector('link[rel=canonical]')?.href ?? null,
      robots: meta('robots'),
      lang: document.documentElement.lang || null,
      h1: [...document.querySelectorAll('h1')].filter(shown).map(h => h.textContent.replace(/\s+/g, ' ').trim()).slice(0, 5),
      ogImage: document.querySelector('meta[property="og:image"]')?.content ?? null,
      jsonld: document.querySelectorAll('script[type="application/ld+json"]').length,
    },
  };
}

// Runs in the page after it was switched to Hindi: English sentences still showing.
export function untranslatedText() {
  // names and short codes that stay in English on the Hindi site
  const KEEP = /^(kartavya|v rakshak|avya|sos|abha|abdm|dpdp|ok|ai|qr|pdf|wi-?fi|otp|faq|faqs|kv-[a-z0-9-]+|everyday|care\+|complete|fall sensor|v rakshak security intelligence|thekartavya\.com|www\.thekartavya\.com|ceo@kartavya\.com|niti aayog|mohfw|lasi|mospi|mosje|english|हिन्दी)$/i;
  const out = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const n = walker.currentNode;
    const t = n.nodeValue.replace(/\s+/g, ' ').trim();
    if (t.length < 4 || !/[A-Za-z]{3,}/.test(t) || /[ऀ-ॿ]/.test(t) || KEEP.test(t)) continue;
    if (/^[\w.+-]+@[\w.-]+$|^https?:|^[\d\s:.,%+/×x-]+[a-z]{0,3}$/i.test(t)) continue;
    const el = n.parentElement;
    if (!el || el.closest('script,style,noscript,svg,code,pre,[translate=no],[lang=en]:not(html):not(body),[aria-hidden=true],.sr-only,.visually-hidden')) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    out.add(t.slice(0, 140));
  }
  return [...out];
}

const added = (before = [], after = []) => { const b = new Set(before); return [...new Set(after)].filter(x => !b.has(x)); };

// before/after on one screen size -> problems the fix brought in (never ones already on main)
export function compareLayout(before, after) {
  const fail = [], warn = [];
  if (after.overflowX && !before.overflowX) fail.push(`the page now scrolls sideways (${after.scrollWidth}px wide on a ${after.width}px screen)${after.wide.length ? `: ${after.wide.slice(0, 3).join(', ')}` : ''}`);
  else for (const w of added(before.wide, after.wide)) warn.push(`sticks out past the screen edge: ${w}`);
  for (const b of added(before.broken, after.broken)) fail.push(`broken image: ${b}`);
  for (const c of added(before.clipped, after.clipped)) warn.push(`text cut off: ${c}`);
  for (const s of added(before.small, after.small)) warn.push(`button or link smaller than a fingertip: ${s}`);
  return { fail, warn };
}

export function compareErrors(before, after) {
  const strip = s => s.replace(/https?:\/\/127\.0\.0\.1:\d+/g, '');
  const b = new Set([...before.errors, ...before.failed].map(strip));
  return [...new Set([...after.errors, ...after.failed].map(strip))].filter(x => !b.has(x));
}

export function compareHead(before, after) {
  const fail = [], warn = [];
  for (const k of ['title', 'description', 'canonical']) {
    if (before[k] && !after[k]) fail.push(`the ${k} tag is gone`);
    else if (before[k] !== after[k]) warn.push(`${k} changed: "${before[k] ?? ''}" -> "${after[k] ?? ''}"`);
  }
  if (before.h1.length === 1 && after.h1.length !== 1) fail.push(`the page should have one main heading, now has ${after.h1.length}`);
  else if (before.h1[0] !== after.h1[0] && after.h1.length) warn.push(`main heading changed: "${after.h1[0]}"`);
  if (before.robots !== after.robots) warn.push(`robots changed: "${before.robots}" -> "${after.robots}"`);
  if (before.jsonld > after.jsonld) fail.push(`structured data blocks went from ${before.jsonld} to ${after.jsonld}`);
  return { fail, warn };
}

export const compareHindi = (before, after) => added(before, after);

export function compareWeight(before, after) {
  const grew = after.bytes - before.bytes;
  if (grew > 300_000 && after.bytes > before.bytes * 1.2) return `the page now downloads ${kb(after.bytes)} (was ${kb(before.bytes)})`;
  return null;
}
export const kb = n => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1000)} KB`);

// the files a fix touched, and its commit messages, against the founder's rules
export function fileRules({ files, commits, forbidden }) {
  const fail = [];
  for (const f of files) if (forbidden.some(re => re.test(f.path))) fail.push(`${f.path} must not be changed`);
  for (const c of commits) if (/co-authored-by:\s*claude/i.test(c.body)) fail.push(`commit ${c.sha.slice(0, 7)} has a Co-Authored-By: Claude line`);
  if (!files.length) fail.push('the branch changes nothing compared with main');
  return fail;
}

// the unit test summary node:test prints
export function parseNodeTest(text) {
  const n = k => { const m = text.match(new RegExp(`^ℹ ${k} (\\d+)`, 'm')) || text.match(new RegExp(`^# ${k} (\\d+)`, 'm')); return m ? Number(m[1]) : null; };
  const failing = [...text.matchAll(/^✖ (.+?)(?: \([\d.]+ms\))?$/gm)].map(m => m[1]).filter(x => !/^failing tests:?$/i.test(x));
  return { tests: n('tests'), pass: n('pass'), fail: n('fail'), failing: [...new Set(failing)].slice(0, 10) };
}

export const verdictOf = checks => (checks.some(c => c.status === 'fail') ? 'fail' : 'pass');

const ICON = { pass: '✅', fail: '❌', warn: '⚠️', skip: '➖' };
// the message kv-checker posts in the thread
export function chatSummary(r) {
  const lines = [
    `**${r.ticket ?? r.branch} check: ${r.verdict === 'pass' ? 'PASS' : 'FAIL'}** · \`${r.branch}\` @ ${r.sha.slice(0, 7)} compared with main @ ${r.base.slice(0, 7)}`,
    '',
    '| Check | Result |',
    '|---|---|',
    ...r.checks.map(c => `| ${c.name} | ${ICON[c.status]} ${c.summary} |`),
  ];
  const problems = r.checks.flatMap(c => (c.status === 'fail' || c.status === 'warn' ? (c.details ?? []).map(d => `- ${ICON[c.status]} ${c.name}: ${d}`) : []));
  if (problems.length) lines.push('', '**What to look at**', ...problems.slice(0, 15), ...(problems.length > 15 ? [`- … and ${problems.length - 15} more in report.md`] : []));
  if (r.attachments?.length) lines.push('', `Screenshots (before on the left, after on the right): ${r.attachments.map(a => a.split(/[\\/]/).pop()).join(', ')}`);
  lines.push('', `Took ${Math.round(r.ms / 1000)} s.`);
  return lines.join('\n');
}
