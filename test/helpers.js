// Scratch folders for tests go under the crew's own state/tmp (on D:), never the system temp on C:.
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { CREW } from '../tools/config.mjs';

export function scratch(prefix) {
  const root = process.env.KV_TEST_TMP || join(CREW, 'state', 'tmp');
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, `${prefix}-`));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) };
}
