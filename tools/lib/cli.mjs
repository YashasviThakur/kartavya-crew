// Small helpers shared by the command-line tools.
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { GIT_ENV } from '../config.mjs';

// true when this module is the script node was started with (not when a test imports it)
export const isMain = url => Boolean(process.argv[1]) && pathToFileURL(resolve(process.argv[1])).href === url;

// run a program and collect what it prints. Never throws on a non-zero exit: callers read `code`.
export function run(cmd, args = [], { cwd, env = {}, timeoutMs = 10 * 60_000, input } = {}) {
  return new Promise(done => {
    const started = Date.now();
    // npm and npx are .cmd files on Windows and need a shell; everything else runs directly
    const shell = process.platform === 'win32' && /^(npm|npx)$/.test(cmd);
    const opts = { cwd, env: { ...process.env, ...GIT_ENV, ...env }, windowsHide: true };
    // through a shell, the whole command goes as one string (only the crew's own fixed npm arguments go this way)
    const child = shell
      ? spawn([cmd, ...args.map(a => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a))].join(' '), { ...opts, shell: true })
      : spawn(cmd, args, opts);
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
    const timer = setTimeout(() => { child.kill(); stderr += `\n[stopped after ${Math.round(timeoutMs / 1000)} s]`; }, timeoutMs);
    child.on('error', e => { clearTimeout(timer); done({ code: 127, stdout, stderr: stderr + e.message, ms: Date.now() - started }); });
    child.on('close', code => { clearTimeout(timer); done({ code: code ?? 1, stdout, stderr, ms: Date.now() - started }); });
  });
}

export const git = (cwd, ...args) => run('git', args, { cwd });
export async function gitOut(cwd, ...args) {
  const r = await git(cwd, ...args);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout.trim();
}

// Git Bash on Windows rewrites an argument like "/how-it-works" into "C:/Program Files/Git/how-it-works"
// before node sees it. Turn such a value back into the site path it was.
export function sitePath(v) {
  const s = String(v ?? '').trim().replace(/\\/g, '/');
  const m = s.match(/^[A-Za-z]:\/(?:.*?\/)?Git(\/.*)?$/i);
  return m ? (m[1] || '/') : s;
}
