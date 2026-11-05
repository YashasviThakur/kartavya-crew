#!/usr/bin/env node
// kv-shipper's only way to release: what ships is exactly the commit kv-checker passed, and it ships into
// the sandbox repo (GITHUB_REPO), never the live one.
//   node tools/ship.mjs KV-001 --approved-by yashasvi             push, open a pull request, wait for GitHub's checks, squash-merge
//   node tools/ship.mjs KV-001 --approved-by yashasvi --dry-run   say what would happen, change nothing
// It refuses when the check did not pass, when the branch got new commits after the check, or when main
// moved since the check (then the fix needs a fresh check against the new main).
import { parseArgs } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { REPO, GITHUB_REPO, LIVE_REPO } from './config.mjs';
import { get, update } from './lib/store.mjs';
import { run, git, gitOut, isMain } from './lib/cli.mjs';

// Pure: is this a place the crew may release into? Never the live repo, by name or by the push address.
export function targetProblem({ repo, pushUrl }) {
  const live = new RegExp(`github\\.com[/:]${LIVE_REPO.replace('/', '\\/')}(\\.git)?/?$`, 'i');
  if (repo.toLowerCase() === LIVE_REPO.toLowerCase()) return `refusing to release into the live repo ${LIVE_REPO}: the crew releases into its sandbox only`;
  if (live.test(pushUrl ?? '')) return `origin in ${REPO} pushes to the live repo (${pushUrl}): run node tools/setup.mjs to point it at the sandbox`;
  if (!new RegExp(`github\\.com[/:]${repo.replace('/', '\\/')}(\\.git)?/?$`, 'i').test(pushUrl ?? '')) return `origin in ${REPO} pushes to ${pushUrl || 'nowhere'}, not ${repo}: run node tools/setup.mjs`;
  return null;
}

// Pure: may this ticket ship right now? Returns { ok, reason }.
export function shipDecision({ ticket, report, branchHead, mainNow, approvedBy }) {
  if (!approvedBy) return { ok: false, reason: 'say who approved it: --approved-by <their handle>' };
  if (ticket.status === 'shipped') return { ok: false, reason: `${ticket.id} already shipped${ticket.pr ? ` (${ticket.pr})` : ''}` };
  if (!ticket.branch) return { ok: false, reason: `${ticket.id} has no branch yet` };
  if (!report) return { ok: false, reason: `${ticket.id} has not been checked yet: ask @kv-checker to check it` };
  if (report.verdict !== 'pass') return { ok: false, reason: `the last check of ${ticket.id} failed: it has to pass before it can ship` };
  if (report.branch !== ticket.branch) return { ok: false, reason: `the last check was of ${report.branch}, not ${ticket.branch}: check again` };
  if (branchHead !== report.sha) return { ok: false, reason: `${ticket.branch} has new commits since it was checked (${report.sha.slice(0, 7)} -> ${branchHead.slice(0, 7)}): check again` };
  if (mainNow !== report.main) return { ok: false, reason: `main moved since the check (${report.main.slice(0, 7)} -> ${mainNow.slice(0, 7)}): check again against the new main` };
  return { ok: true, reason: 'checked, unchanged since, and approved' };
}

export function prBody({ ticket, report, approvedBy }) {
  const rows = report.checks.map(c => `| ${c.name} | ${c.status} · ${c.summary} |`).join('\n');
  return [
    `**${ticket.id}: ${ticket.title}**`,
    '',
    `Reported by ${ticket.reporter} in the Kartavya feedback room. Page: \`${ticket.page}\`.`,
    ticket.detail ? `\n> ${ticket.detail.slice(0, 600)}\n` : '',
    `Checked by kv-checker at ${report.sha.slice(0, 7)} against main ${report.main.slice(0, 7)}:`,
    '',
    '| Check | Result |',
    '|---|---|',
    rows,
    '',
    `Approved for release by ${approvedBy}. Merged by kv-shipper (Kartavya crew on Switch).`,
  ].join('\n');
}

const gh = (...args) => run('gh', args, { cwd: REPO, timeoutMs: 30 * 60_000 });

// GitHub registers a pull request's checks a few seconds after the PR opens; asked too soon, gh answers
// "no checks reported" and exits non-zero. That is "not started yet", not a failure: wait and ask again.
export const noChecksYet = out => /no checks reported/i.test(out ?? '');
const CHECKS_START_TRIES = 12, CHECKS_START_PAUSE_MS = 10_000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function ship({ id, approvedBy, dryRun = false, waitCi = true, log = m => console.error(m) }) {
  const pushUrl = (await git(REPO, 'remote', 'get-url', '--push', 'origin')).stdout.trim();
  const wrong = targetProblem({ repo: GITHUB_REPO, pushUrl });
  if (wrong) return { shipped: false, reason: wrong };
  const ticket = get(id);
  const report = ticket.report && existsSync(ticket.report) ? JSON.parse(readFileSync(ticket.report, 'utf8')) : null;
  await git(REPO, 'fetch', '--quiet', 'origin');
  const branchHead = ticket.branch ? await gitOut(REPO, 'rev-parse', '--verify', `${ticket.branch}^{commit}`).catch(() => '') : '';
  const mainNow = await gitOut(REPO, 'rev-parse', 'origin/main');
  const d = shipDecision({ ticket, report, branchHead, mainNow, approvedBy });
  if (!d.ok) return { shipped: false, reason: d.reason };

  const title = `${ticket.id}: ${ticket.title}`;
  const steps = [
    ['push', ['git', 'push', 'origin', `${report.sha}:refs/heads/${ticket.branch}`]],
    ['open the pull request', ['gh', 'pr', 'create', '--repo', GITHUB_REPO, '--base', 'main', '--head', ticket.branch, '--title', title, '--body', prBody({ ticket, report, approvedBy })]],
    ...(waitCi ? [['wait for GitHub\'s checks', ['gh', 'pr', 'checks', ticket.branch, '--repo', GITHUB_REPO, '--watch', '--interval', '20']]] : []),
    ['squash-merge', ['gh', 'pr', 'merge', ticket.branch, '--repo', GITHUB_REPO, '--squash', '--delete-branch', '--subject', title, '--body', `Reported by ${ticket.reporter}. Checked by kv-checker (${report.sha.slice(0, 7)}). Approved by ${approvedBy}.`]],
  ];
  if (dryRun) return { shipped: false, dryRun: true, reason: d.reason, steps: steps.map(([what, cmd]) => `${what}: ${cmd.slice(0, 6).join(' ')} …`) };

  update(ticket.id, {}, { by: 'kv-shipper', note: `release approved by ${approvedBy}` });
  let pr = '';
  for (const [what, [cmd, ...args]] of steps) {
    log(`${what}…`);
    let r = cmd === 'git' ? await git(REPO, ...args) : await gh(...args);
    if (what === "wait for GitHub's checks") {
      for (let i = 0; i < CHECKS_START_TRIES && r.code !== 0 && noChecksYet(`${r.stderr} ${r.stdout}`); i++) {
        log("GitHub has not started its checks yet, asking again…");
        await sleep(CHECKS_START_PAUSE_MS);
        r = await gh(...args);
      }
    }
    if (what === 'open the pull request') {
      // already open from an earlier try: use it
      pr = (r.stdout.match(/https:\/\/github\.com\/\S+\/pull\/\d+/) || (r.stderr.match(/https:\/\/github\.com\/\S+\/pull\/\d+/)) || [''])[0];
      if (r.code !== 0 && !pr) return { shipped: false, reason: `could not open the pull request: ${(r.stderr || r.stdout).trim()}` };
      continue;
    }
    if (r.code !== 0) {
      update(ticket.id, { pr: pr || undefined }, { by: 'kv-shipper', note: `${what} failed` });
      const out = (r.stderr || r.stdout).trim().split('\n').slice(-4).join(' ');
      return { shipped: false, pr, reason: what === "wait for GitHub's checks" ? `GitHub's checks failed on the pull request, so it was not merged: ${out}` : `${what} failed: ${out}` };
    }
  }
  const merged = (await gh('pr', 'view', ticket.branch, '--repo', GITHUB_REPO, '--json', 'mergeCommit', '--jq', '.mergeCommit.oid')).stdout.trim();
  update(ticket.id, { status: 'shipped', pr, merged }, { by: 'kv-shipper', note: `merged as ${merged.slice(0, 7)}` });
  return { shipped: true, pr, merged, reason: d.reason };
}

if (isMain(import.meta.url)) {
  const { values: v, positionals: [id] } = parseArgs({ allowPositionals: true, options: { 'approved-by': { type: 'string' }, 'dry-run': { type: 'boolean' }, 'no-wait-ci': { type: 'boolean' } } });
  try {
    if (!id) throw new Error('usage: ship.mjs KV-### --approved-by <handle> [--dry-run]');
    const r = await ship({ id, approvedBy: v['approved-by'], dryRun: v['dry-run'], waitCi: !v['no-wait-ci'] });
    if (r.dryRun) console.log(`Would ship (${r.reason}):\n${r.steps.map(s => `- ${s}`).join('\n')}`);
    else if (r.shipped) console.log(`Shipped ${id}: ${r.pr} (merged as ${r.merged.slice(0, 7)}). Live after the next deploy.`);
    else console.log(`Not shipped: ${r.reason}${r.pr ? `\nPull request: ${r.pr}` : ''}`);
    process.exit(r.shipped || r.dryRun ? 0 : 2);
  } catch (e) { console.error(e.message); process.exit(1); }
}
