import { execFile } from 'node:child_process';
import { access, readdir, rename } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const target = process.argv[2];
const start = process.argv[3];
if (!target || !start) throw new Error('Usage: node migrate-meeting-dates.mjs <minutes-folder> <start-iso>');
const dws = process.env.DWS_PATH || path.join(process.env.HOME || '', '.local/bin/dws');

async function list() {
  const items = [];
  const seen = new Set();
  let token;
  do {
    const args = ['minutes', 'list', 'all', '--start', start, '--max', '30', '--format', 'json'];
    if (token) args.push('--next-token', token);
    const { stdout } = await execFileAsync(dws, args);
    const result = JSON.parse(stdout).result;
    items.push(...(result.itemList || []));
    token = result.nextToken;
    if (token && seen.has(token)) break;
    if (token) seen.add(token);
  } while (token);
  return items;
}

const records = new Map((await list()).filter(item => item.uuid && item.startTimeISO).map(item => [item.uuid.slice(-8), item]));
let renamed = 0;
let collisions = 0;
for (const name of await readdir(target)) {
  const match = name.match(/^\d{4}-\d{2}-\d{2} (.+) \[([0-9a-f]{8})\]\.md$/i);
  if (!match) continue;
  const record = records.get(match[2]);
  if (!record) continue;
  const expected = `${record.startTimeISO.slice(0, 10)} ${match[1]} [${match[2]}].md`;
  if (expected === name) continue;
  const source = path.join(target, name);
  const destination = path.join(target, expected);
  try {
    await access(destination);
    collisions++;
    continue;
  } catch {
    await rename(source, destination);
    renamed++;
  }
}
console.log(`Renamed ${renamed} files; ${collisions} destination collisions left unchanged.`);
