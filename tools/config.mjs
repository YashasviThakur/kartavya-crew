// Where everything lives. Every path can be moved with an environment variable, so the tests (and another
// machine) can point the crew somewhere else.
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const here = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const env = (name, fallback) => (process.env[name] || fallback).replace(/\\/g, '/');

export const CREW = env('KV_CREW_HOME', here);
export const STATE = env('KV_CREW_STATE', join(CREW, 'state'));
export const WORK = env('KV_CREW_WORK', join(CREW, 'work'));
export const REPO = join(WORK, 'repo');       // the crew's own clone of the Kartavya site
export const BUILDER = join(WORK, 'builder'); // kv-builder edits here (a worktree of REPO)
export const CHECKER = join(WORK, 'checker'); // check.mjs checks out the branch under test here
export const BASE = join(WORK, 'base');       // ... and main here, for the "before" screenshots
export const TMP = join(STATE, 'tmp');        // Chrome profiles and other scratch, never on C:

// the founder's own checkout on the USB drive: cloned once by setup, never written to
export const SOURCE_REPO = env('KV_SOURCE_REPO', 'E:/Kartavya/Website repo (kartvaya)');
// The crew releases into a private sandbox copy of the site. The live repo (which deploys thekartavya.com)
// is only ever read: setup makes its push address unusable, a pre-push hook refuses it, and ship.mjs
// refuses to run against it.
export const LIVE_REPO = 'YashasviThakur/kartavya';
export const GITHUB_REPO = process.env.KV_GITHUB_REPO || 'YashasviThakur/kartavya-crew-sandbox';
export const LIVE = process.env.KV_LIVE || 'https://www.thekartavya.com';
export const API = process.env.KV_API || 'https://2kzzq9b4bi.execute-api.ap-south-1.amazonaws.com';
export const DEMO = process.env.KV_DEMO || 'https://demokartavya.vercel.app';
export const FILMS = env('KV_FILMS', 'D:/Kartavya-HyperFrames');
export const VIDEOS = env('KV_VIDEOS', 'E:/Kartavya/Videos');

// the screen sizes every visual check uses (the same three the site's own deep UI check used)
export const SIZES = {
  phone: { width: 390, height: 844, mobile: true, scale: 2 },
  tablet: { width: 820, height: 1180, mobile: true, scale: 1 },
  desktop: { width: 1440, height: 900, mobile: false, scale: 1 },
};

// files a fix must never touch: the founder keeps these out of every commit
export const FORBIDDEN = [/^portal-bundles\.css$/, /^dawn\.css$/, /\.pdf$/i, /(^|\/)\.env(\.|$)/, /^cdk-outputs\.json$/, /^backend\/cdk\.out\//];

// git on the USB drive reports "dubious ownership"; this lets every git call through without a global setting
export const GIT_ENV = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: '*' };
