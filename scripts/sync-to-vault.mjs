import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const [vaultPath, start, ...requestedIds] = process.argv.slice(2);
if (!vaultPath || !start) throw new Error('Usage: node sync-to-vault.mjs <vault-path> <start-iso>');
const target = path.join(vaultPath, 'DingTalk Minutes');
const dws = process.env.DWS_PATH || path.join(process.env.HOME || '', '.local/bin/dws');

async function call(args) {
  const { stdout } = await execFileAsync(dws, [...args, '--format', 'json'], { maxBuffer: 20 * 1024 * 1024 });
  const payload = JSON.parse(stdout);
  if (!payload.success) throw new Error(payload.errorMsg || `dws failed: ${args.join(' ')}`);
  return payload.result;
}

async function listAll() {
  const records = [];
  const seenCursors = new Set();
  let cursor;
  do {
    const args = ['minutes', 'list', 'all', '--start', start, '--max', '30'];
    if (cursor) args.push('--cursor', cursor);
    const result = await call(args);
    records.push(...(result.itemList || []));
    cursor = result.cursor || result.nextToken || result.next_token;
    if (cursor && seenCursors.has(cursor)) {
      console.warn('dws returned a repeated list cursor; stopping pagination safely.');
      break;
    }
    if (cursor) seenCursors.add(cursor);
  } while (cursor);
  return records;
}

async function transcript(uuid) {
  const pages = [];
  const seenTokens = new Set();
  let nextToken;
  do {
    const args = ['minutes', 'get', 'transcription', '--id', uuid];
    if (nextToken) args.push('--next-token', nextToken);
    const result = await call(args);
    pages.push(result);
    nextToken = result.nextToken;
    if (nextToken && seenTokens.has(nextToken)) {
      console.warn(`dws returned a repeated transcription token for ${uuid}; stopping pagination safely.`);
      break;
    }
    if (nextToken) seenTokens.add(nextToken);
  } while (nextToken);
  return pages;
}

function clean(name) { return name.replace(/[\\/:*?"<>|#[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) || '未命名听记'; }
function text(value) { return typeof value === 'string' ? value.replace(/\\n/g, '\n').trim() : ''; }
function summarySection(value) { const body = text(value.fullSummary) || text(value.summary) || text(value.content); return body ? `## AI 摘要\n\n${body}` : ''; }
function keywordsSection(value) { const items = Array.isArray(value.keywords) ? value.keywords.map(text).filter(Boolean) : []; return items.length ? `## 关键词\n\n${items.map(item => `#${item.replace(/\s+/g, '-')}`).join(' ')}` : ''; }
function todosSection(value) {
  const actions = Array.isArray(value.actions) ? value.actions : Array.isArray(value.dingtalkTodoList) ? value.dingtalkTodoList : [];
  const items = actions.map(action => {
    if (typeof action === 'string') { try { return text(JSON.parse(action).value) || action; } catch { return action; } }
    return text(action.value) || text(action.title);
  }).filter(Boolean);
  return items.length ? `## 待办\n\n${items.map(item => `- [ ] ${item}`).join('\n')}` : '';
}
function timestamp(milliseconds) { const seconds = typeof milliseconds === 'number' ? Math.floor(milliseconds / 1000) : 0; return `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds % 3600 / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`; }
function transcriptSection(pages) {
  const lines = pages.flatMap(page => Array.isArray(page.paragraphList) ? page.paragraphList : []).map(paragraph => {
    const speaker = text(paragraph.nickName) || text(paragraph.speakerDisplay?.nickName) || '发言人';
    const content = text(paragraph.paragraph);
    return content ? `**${speaker}** · ${timestamp(paragraph.startTime)}\n\n${content}` : '';
  }).filter(Boolean);
  return lines.length ? `## 逐字稿\n\n${lines.join('\n\n---\n\n')}` : '';
}

await mkdir(target, { recursive: true });
const records = requestedIds.length ? requestedIds.map(uuid => ({ uuid })) : await listAll();
console.log(`Found ${records.length} minutes since ${start}`);
for (let index = 0; index < records.length; index++) {
  const record = records[index];
  const uuid = record.uuid;
  if (!uuid) continue;
  console.log(`[${index + 1}/${records.length}] ${record.title || uuid}`);
  const [info, summary, keywords, todos, transcription] = await Promise.all([
    call(['minutes', 'get', 'info', '--id', uuid]),
    call(['minutes', 'get', 'summary', '--id', uuid]),
    call(['minutes', 'get', 'keywords', '--id', uuid]),
    call(['minutes', 'get', 'todos', '--id', uuid]),
    transcript(uuid),
  ]);
  const title = info.title || record.title || '未命名听记';
  const created = info.startTimeISO || record.startTimeISO || '';
  const content = [
    '---',
    'source: dingtalk-minutes',
    `taskUuid: ${JSON.stringify(uuid)}`,
    `title: ${JSON.stringify(title)}`,
    created ? `created: ${JSON.stringify(created)}` : '',
    `synced: ${JSON.stringify(new Date().toISOString())}`,
    'tags: [钉钉听记, 会议纪要]',
    '---', '', `# ${title}`, '',
    summarySection(summary), keywordsSection(keywords), todosSection(todos), transcriptSection(transcription),
  ].filter(Boolean).join('\n\n') + '\n';
  const date = (created || new Date().toISOString()).slice(0, 10);
  const file = path.join(target, `${date} ${clean(title)} [${uuid.slice(-8)}].md`);
  await writeFile(file, content, 'utf8');
  createHash('sha256').update(content).digest('hex');
}
console.log(`Synced ${records.length} minutes to ${target}`);
