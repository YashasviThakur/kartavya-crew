#!/usr/bin/env node
// Get this computer ready for the crew.
//   node tools/setup.mjs --doctor   check what is installed and running; change nothing
//   node tools/setup.mjs            the same checks, then create the crew's working copies of the site:
//     work/repo     a clone of the founder's checkout (SOURCE_REPO), pointed at GitHub, never pushed by hand
//     work/builder  where kv-builder makes fixes (a worktree of work/repo)
//     work/checker  where check.mjs puts the branch under test
//     work/base     where check.mjs puts main, for the "before" screenshots
//     agents/<name> the working folders of the agents that do not edit the site
// The founder's own checkout is only read, once, to clone it.
import { existsSync, mkdirSync, writeFileSync, statfsSync, copyFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { CREW, STATE, WORK, REPO, BUILDER, CHECKER, BASE, TMP, SOURCE_REPO, GITHUB_REPO, LIVE_REPO, FILMS } from './config.mjs';
import { run, git, gitOut, isMain } from './lib/cli.mjs';
import { chromePath } from './lib/cdp.mjs';

const line = (ok, what, detail) => console.log(`${ok === null ? '  ' : ok ? '✅' : '❌'} ${what}${detail ? ` · ${detail}` : ''}`);

export async function doctor() {
  let ready = true;
  const need = (ok, what, detail) => { line(ok, what, detail); if (ok === false) ready = false; };
  const major = Number(process.versions.node.split('.')[0]);
  need(major >= 22, `Node ${process.versions.node}`, major >= 22 ? '' : 'needs 22 or newer');
  const g = await run('git', ['--version']); need(g.code === 0, 'git', g.stdout.trim());
  const ghv = await run('gh', ['auth', 'status']); need(ghv.code === 0, 'GitHub CLI signed in', ghv.code === 0 ? '' : 'run: gh auth login');
  const cl = await run('claude', ['--version']); need(cl.code === 0, 'Claude Code', cl.code === 0 ? cl.stdout.trim() : 'install Claude Code and run: claude auth login');
  const dk = await run('docker', ['info', '--format', '{{.ServerVersion}}']); need(dk.code === 0, 'Docker running', dk.code === 0 ? `server ${dk.stdout.trim()}` : 'start Docker Desktop');
  need(Boolean(chromePath()), 'Chrome for the checks', chromePath() ?? 'install Google Chrome or set CHROME');
  const consoleDirs = [join(process.env.LOCALAPPDATA ?? '', 'Programs', 'switch-console'), join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Switch Console'), '/Applications/Switch Console.app'];
  const sc = consoleDirs.find(d => existsSync(d));
  line(sc ? true : null, 'Switch Console', sc ?? 'not found where expected; install it from github.com/sandbox-quantum/switch/releases');
  need(existsSync(SOURCE_REPO), `Kartavya repo at ${SOURCE_REPO}`, existsSync(SOURCE_REPO) ? '' : 'plug in the drive, or set KV_SOURCE_REPO');
  try { const s = statfsSync(CREW); const gb = (s.bavail * s.bsize) / 1e9; need(gb > 5, `Free space where the crew lives`, `${gb.toFixed(1)} GB`); } catch {}
  line(existsSync(FILMS) ? true : null, `Film projects at ${FILMS}`, existsSync(FILMS) ? '' : 'kv-producer will have nothing to render');
  for (const [name, dir] of [['work/repo', REPO], ['work/builder', BUILDER], ['work/checker', CHECKER], ['work/base', BASE]]) line(existsSync(join(dir, '.git')) ? true : null, name, existsSync(join(dir, '.git')) ? '' : 'not created yet: run node tools/setup.mjs');
  line(existsSync(join(STATE, 'watchdog.json')) ? true : null, 'kv-watchdog registered', existsSync(join(STATE, 'watchdog.json')) ? '' : 'later: node watchdog/register.mjs');
  return ready;
}

const AGENT_NOTES = {
  triager: 'kv-triager works from here. Its tools: node ../../tools/ticket.mjs new|set|show|list|board. It reads the site in ../../work/repo and never edits it.',
  checker: 'kv-checker works from here. Its tool: node ../../tools/check.mjs --ticket KV-###. Reports and screenshots land in ../../state/reports.',
  shipper: 'kv-shipper works from here. Its tools: node ../../tools/ship.mjs KV-### --approved-by <handle>, node ../../tools/notes.mjs --since 7, node ../../tools/health.mjs.',
};

// origin = the sandbox (fetch and push); live = the real site's repo, fetch only; a pre-push hook that
// refuses the live repo whatever remote or URL a push names. Safe to run again.
async function wireRemotes() {
  const remotes = (await gitOut(REPO, 'remote')).split('\n').filter(Boolean);
  const liveUrl = `https://github.com/${LIVE_REPO}.git`, sandboxUrl = `https://github.com/${GITHUB_REPO}.git`;
  if (remotes.includes('origin') && /YashasviThakur\/kartavya(\.git)?$/i.test((await gitOut(REPO, 'remote', 'get-url', 'origin')))) {
    if (!remotes.includes('live')) { await gitOut(REPO, 'remote', 'rename', 'origin', 'live'); remotes.splice(remotes.indexOf('origin'), 1, 'live'); }
    else { await gitOut(REPO, 'remote', 'remove', 'origin'); remotes.splice(remotes.indexOf('origin'), 1); }
  }
  if (!remotes.includes('live')) await gitOut(REPO, 'remote', 'add', 'live', liveUrl);
  await gitOut(REPO, 'remote', 'set-url', 'live', liveUrl);
  await gitOut(REPO, 'remote', 'set-url', '--push', 'live', 'BLOCKED: the live Kartavya repo is read-only for the crew');
  if (!remotes.includes('origin')) await gitOut(REPO, 'remote', 'add', 'origin', sandboxUrl);
  else await gitOut(REPO, 'remote', 'set-url', 'origin', sandboxUrl);
  await git(REPO, 'remote', 'set-url', '--delete', '--push', 'origin', '.*'); // no separate push address on origin
  const hooks = join(await gitOut(REPO, 'rev-parse', '--path-format=absolute', '--git-common-dir'), 'hooks');
  mkdirSync(hooks, { recursive: true });
  copyFileSync(join(CREW, 'tools', 'pre-push-guard.sh'), join(hooks, 'pre-push'));
  try { chmodSync(join(hooks, 'pre-push'), 0o755); } catch {}
  // a brand-new sandbox starts as a copy of the live site's main
  await git(REPO, 'fetch', '--quiet', 'live');
  const sandboxMain = (await git(REPO, 'ls-remote', 'origin', 'refs/heads/main')).stdout.trim();
  if (!sandboxMain) {
    console.log(`seeding ${GITHUB_REPO} with the live site's main…`);
    await gitOut(REPO, 'push', '--quiet', 'origin', 'refs/remotes/live/main:refs/heads/main');
  }
  console.log(`remotes: origin -> ${GITHUB_REPO} (releases go here) · live -> ${LIVE_REPO} (read only)`);
}

export async function setup() {
  for (const d of [STATE, TMP, WORK]) mkdirSync(d, { recursive: true });
  for (const [name, note] of Object.entries(AGENT_NOTES)) {
    const dir = join(CREW, 'agents', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'CLAUDE.md'), `# ${name}\n\n${note}\n\nThe crew's tools are in ${CREW}/tools. Keep temporary files under ${TMP}.\n`);
  }
  if (!existsSync(join(REPO, '.git'))) {
    if (!existsSync(SOURCE_REPO)) throw new Error(`the Kartavya repo is not at ${SOURCE_REPO}: plug in the drive (or set KV_SOURCE_REPO) and run setup again`);
    console.log(`cloning ${SOURCE_REPO} -> ${REPO} (read only on the source)…`);
    const c = await run('git', ['clone', '--quiet', '--no-hardlinks', SOURCE_REPO, REPO], { timeoutMs: 20 * 60_000 });
    if (c.code !== 0) throw new Error(`clone failed: ${c.stderr.trim()}`);
    await gitOut(REPO, 'remote', 'remove', 'origin');
    // commits made by the crew carry the founder's own name and email, exactly as in their checkout
    for (const k of ['user.name', 'user.email']) {
      const v = (await git(SOURCE_REPO, 'config', k)).stdout.trim() || (await git(homedir(), 'config', '--global', k)).stdout.trim();
      if (v) await gitOut(REPO, 'config', k, v);
    }
  }
  await wireRemotes();
  console.log('fetching main from the sandbox…');
  const f = await git(REPO, 'fetch', '--quiet', 'origin');
  if (f.code !== 0) console.log(`  could not reach GitHub (${f.stderr.trim().split('\n').pop()}); using the main the clone came with`);
  const main = (await git(REPO, 'rev-parse', '--verify', 'origin/main')).code === 0 ? 'origin/main' : 'main';
  for (const dir of [BUILDER, CHECKER, BASE]) {
    if (existsSync(join(dir, '.git'))) continue;
    await gitOut(REPO, 'worktree', 'add', '--quiet', '--detach', dir, main);
    console.log(`made ${dir}`);
  }
  console.log(`\nReady. The crew's copy of the site is at ${(await gitOut(REPO, 'rev-parse', '--short', main))} (${main}).`);
}

if (isMain(import.meta.url)) {
  const onlyCheck = process.argv.includes('--doctor');
  const ready = await doctor();
  if (onlyCheck) process.exit(ready ? 0 : 1);
  try { await setup(); } catch (e) { console.error(`\nSetup stopped: ${e.message}`); process.exit(1); }
  console.log(['', 'Next:', '1. Switch Console: Templates, import switch/kartavya-crew.template.yaml, fill in your chat handle, Create.', '2. Gateway, API Keys: create a registration key, then', '   node watchdog/register.mjs --api <bridge URL> --key <key>', '   then in kartavya-ops: !invite-agent @kv-watchdog, and run node watchdog/watchdog.mjs'].join('\n'));
}
