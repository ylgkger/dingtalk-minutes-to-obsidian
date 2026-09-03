import { App, Notice, Plugin, PluginSettingTab, Setting, normalizePath } from 'obsidian';
import { createHash } from 'crypto';
import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

type JsonObject = Record<string, unknown>;

interface MinutesSettings {
  dwsPath: string;
  targetFolder: string;
  scope: 'all' | 'mine' | 'shared';
  initialSyncRangeDays: 7 | 30 | 365;
  initialSyncStart: string | null;
  includeTranscript: boolean;
  syncOnStartup: boolean;
  syncEveryMinutes: number;
  lastSyncAt: number;
  hashes: Record<string, string>;
  files: Record<string, string>;
}

const DEFAULT_SETTINGS: MinutesSettings = {
  dwsPath: 'dws',
  targetFolder: 'DingTalk Minutes',
  scope: 'all',
  initialSyncRangeDays: 30,
  initialSyncStart: null,
  includeTranscript: true,
  syncOnStartup: false,
  syncEveryMinutes: 0,
  lastSyncAt: 0,
  hashes: {},
  files: {},
};

class DwsMinutesClient {
  constructor(private readonly binary: string) {}

  async list(scope: MinutesSettings['scope'], start?: string): Promise<JsonObject[]> {
    const items: JsonObject[] = [];
    const seenTokens = new Set<string>();
    let nextToken: string | undefined;
    do {
      const args = ['minutes', 'list', scope, '--max', '30', '--format', 'json'];
      if (start) args.push('--start', start);
      if (nextToken) args.push('--next-token', nextToken);
      const payload = await this.run(args);
      items.push(...this.items(payload));
      nextToken = this.nextToken(payload);
      if (nextToken && seenTokens.has(nextToken)) {
        console.warn('dws returned a repeated minutes list token; stopping pagination safely.');
        break;
      }
      if (nextToken) seenTokens.add(nextToken);
    } while (nextToken);
    return items;
  }

  async get(kind: 'info' | 'summary' | 'keywords' | 'todos', taskUuid: string): Promise<unknown> {
    return this.run(['minutes', 'get', kind, '--id', taskUuid, '--format', 'json']);
  }

  async transcription(taskUuid: string): Promise<unknown[]> {
    const pages: unknown[] = [];
    const seenTokens = new Set<string>();
    let nextToken: string | undefined;
    do {
      const args = ['minutes', 'get', 'transcription', '--id', taskUuid, '--format', 'json'];
      if (nextToken) args.push('--next-token', nextToken);
      const payload = await this.run(args);
      pages.push(payload);
      nextToken = this.nextToken(payload);
      if (nextToken && seenTokens.has(nextToken)) {
        console.warn(`dws returned a repeated transcription token for ${taskUuid}; stopping pagination safely.`);
        break;
      }
      if (nextToken) seenTokens.add(nextToken);
    } while (nextToken);
    return pages;
  }

  private async run(args: string[]): Promise<unknown> {
    try {
      const { stdout } = await execFileAsync(this.binary, args, { maxBuffer: 20 * 1024 * 1024 });
      return JSON.parse(stdout) as unknown;
    } catch (error) {
      if (isObject(error) && error.code === 'ENOENT') {
        throw new Error('找不到 dws。请在插件设置的“dws 路径”中填写其绝对路径，例如 ~/.local/bin/dws。');
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`dws 调用失败（${args.slice(0, 4).join(' ')}）：${detail}`);
    }
  }

  private items(payload: unknown): JsonObject[] {
    const root = unwrap(payload);
    if (Array.isArray(root)) return root.filter(isObject);
    if (!isObject(root)) return [];
    for (const key of ['itemList', 'items', 'list', 'records', 'data', 'result']) {
      const value = root[key];
      if (Array.isArray(value)) return value.filter(isObject);
    }
    return [];
  }

  private nextToken(payload: unknown): string | undefined {
    const root = unwrap(payload);
    if (!isObject(root)) return undefined;
    for (const key of ['nextToken', 'next_token', 'cursor']) {
      const value = root[key];
      if (typeof value === 'string' && value) return value;
    }
    return undefined;
  }
}

export default class DingTalkMinutesSyncPlugin extends Plugin {
  settings!: MinutesSettings;
  private intervalId: number | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new MinutesSettingsTab(this.app, this));
    this.addCommand({ id: 'sync-dingtalk-minutes', name: 'Sync DingTalk AI Minutes now', callback: () => this.sync() });
    this.addRibbonIcon('mic', 'Sync DingTalk AI Minutes', () => void this.sync());
    this.configureSchedule();
    if (this.settings.syncOnStartup) window.setTimeout(() => void this.sync(), 2000);
  }

  onunload(): void {
    if (this.intervalId !== null) window.clearInterval(this.intervalId);
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.configureSchedule();
  }

  async sync(): Promise<void> {
    const notice = new Notice('正在同步钉钉 AI 听记…', 10_000);
    try {
      const client = new DwsMinutesClient(resolveDwsPath(this.settings.dwsPath));
      if (!this.settings.initialSyncStart) {
        this.settings.initialSyncStart = new Date(Date.now() - this.settings.initialSyncRangeDays * 86_400_000).toISOString();
      }
      const records = await client.list(this.settings.scope, this.settings.initialSyncStart);
      let created = 0;
      let updated = 0;
      let skipped = 0;
      let transcriptUnavailable = 0;
      await this.ensureFolder(this.settings.targetFolder);

      for (const record of records) {
        const taskUuid = taskId(record);
        if (!taskUuid) continue;
        const [info, summary, keywords, todos] = await Promise.all([
          client.get('info', taskUuid),
          client.get('summary', taskUuid),
          client.get('keywords', taskUuid),
          client.get('todos', taskUuid),
        ]);
        let transcript: unknown[] = [];
        let transcriptWarning = '';
        if (this.settings.includeTranscript) {
          try {
            transcript = await client.transcription(taskUuid);
          } catch (error) {
            transcriptUnavailable++;
            transcriptWarning = '钉钉未能返回该条听记的逐字稿；摘要、关键词和待办已成功同步。';
            console.warn(`Transcript unavailable for ${taskUuid}`, error);
          }
        }
        const markdown = renderMarkdown(taskUuid, record, info, summary, keywords, todos, transcript, transcriptWarning);
        const digest = createHash('sha256').update(markdown).digest('hex');
        if (this.settings.hashes[taskUuid] === digest) { skipped++; continue; }
        const desiredFile = this.pathFor(record, taskUuid, info);
        let file = this.settings.files[taskUuid] || desiredFile;
        if (file !== desiredFile && await this.app.vault.adapter.exists(file) && !(await this.app.vault.adapter.exists(desiredFile))) {
          await this.app.vault.rename(this.app.vault.getAbstractFileByPath(file)!, desiredFile);
          file = desiredFile;
        }
        const exists = await this.app.vault.adapter.exists(file);
        await this.app.vault.adapter.write(file, markdown);
        this.settings.hashes[taskUuid] = digest;
        this.settings.files[taskUuid] = file;
        exists ? updated++ : created++;
      }
      this.settings.lastSyncAt = Date.now();
      await this.saveData(this.settings);
      notice.setMessage(`钉钉听记同步完成：新增 ${created}，更新 ${updated}，未变更 ${skipped}${transcriptUnavailable ? `；${transcriptUnavailable} 条逐字稿不可用` : ''}。`);
      window.setTimeout(() => notice.hide(), 5_000);
    } catch (error) {
      console.error('DingTalk Minutes sync failed', error);
      notice.setMessage(error instanceof Error ? error.message : String(error));
      window.setTimeout(() => notice.hide(), 8_000);
    }
  }

  private async ensureFolder(folder: string): Promise<void> {
    const path = normalizePath(folder);
    if (!(await this.app.vault.adapter.exists(path))) await this.app.vault.createFolder(path);
  }

  private pathFor(record: JsonObject, taskUuid: string, info?: unknown): string {
    const title = text(record, ['title', 'name', 'taskName']) || '未命名听记';
    const date = meetingTime(record, info).slice(0, 10);
    return normalizePath(`${this.settings.targetFolder}/${date} ${safeName(title)} [${taskUuid.slice(-8)}].md`);
  }

  private configureSchedule(): void {
    if (this.intervalId !== null) window.clearInterval(this.intervalId);
    this.intervalId = null;
    if (this.settings.syncEveryMinutes > 0) {
      this.intervalId = window.setInterval(() => void this.sync(), this.settings.syncEveryMinutes * 60_000);
    }
  }
}

class MinutesSettingsTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: DingTalkMinutesSyncPlugin) { super(app, plugin); }
  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl).setName('DingTalk AI Minutes Sync').setHeading();
    containerEl.createEl('p', { text: '需要在此电脑安装并登录 dws；插件不会保存钉钉密码、Cookie 或 AppSecret。' });
    new Setting(containerEl).setName('dws 路径').setDesc('留空或填 dws 时，会自动识别 ~/.local/bin/dws、/opt/homebrew/bin/dws 和 /usr/local/bin/dws；也可填写绝对路径。').addText(t => t.setValue(this.plugin.settings.dwsPath).onChange(async v => { this.plugin.settings.dwsPath = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName('同步目录').addText(t => t.setValue(this.plugin.settings.targetFolder).onChange(async v => { this.plugin.settings.targetFolder = v || DEFAULT_SETTINGS.targetFolder; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName('同步范围').setDesc('all 包含自己创建及共享给你的听记。').addDropdown(d => d.addOptions({ all: '全部可访问', mine: '仅我创建', shared: '仅共享给我' }).setValue(this.plugin.settings.scope).onChange(async v => { this.plugin.settings.scope = v as MinutesSettings['scope']; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName('首次同步时间范围').setDesc('首次成功同步时确定起点；之后只同步该起点之后的听记，避免导入更早的历史内容。').addDropdown(d => d.addOptions({ '7': '最近 7 天', '30': '最近 30 天', '365': '最近一年' }).setValue(String(this.plugin.settings.initialSyncRangeDays)).onChange(async v => { this.plugin.settings.initialSyncRangeDays = Number(v) as MinutesSettings['initialSyncRangeDays']; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName('包含逐字稿').addToggle(t => t.setValue(this.plugin.settings.includeTranscript).onChange(async v => { this.plugin.settings.includeTranscript = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName('启动时同步').addToggle(t => t.setValue(this.plugin.settings.syncOnStartup).onChange(async v => { this.plugin.settings.syncOnStartup = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName('定时同步（分钟）').setDesc('填 0 关闭。').addText(t => t.setValue(String(this.plugin.settings.syncEveryMinutes)).onChange(async v => { this.plugin.settings.syncEveryMinutes = Math.max(0, Number.parseInt(v, 10) || 0); await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName('立即同步').addButton(b => b.setButtonText('同步').setCta().onClick(() => void this.plugin.sync()));
  }
}

function isObject(value: unknown): value is JsonObject { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function resolveDwsPath(configured: string): string {
  const value = configured.trim();
  if (value && value !== 'dws') return value.replace(/^~(?=\/)/, process.env.HOME || '~');
  const home = process.env.HOME || '';
  const candidates = [
    process.env.DWS_PATH,
    home ? `${home}/.local/bin/dws` : undefined,
    '/opt/homebrew/bin/dws',
    '/usr/local/bin/dws',
  ].filter((candidate): candidate is string => Boolean(candidate));
  return candidates.find(existsSync) || 'dws';
}
function unwrap(value: unknown): unknown {
  if (!isObject(value)) return value;
  if (value.data !== undefined) return value.data;
  if (value.result !== undefined) return value.result;
  return value;
}
function text(value: unknown, keys: string[]): string | undefined { const root = unwrap(value); if (!isObject(root)) return undefined; for (const key of keys) if (typeof root[key] === 'string') return root[key] as string; return undefined; }
function meetingTime(...values: unknown[]): string {
  for (const value of values) {
    const root = unwrap(value);
    if (!isObject(root)) continue;
    for (const key of ['startTimeISO', 'startTime', 'createTimeISO', 'createdAt', 'createTime']) {
      const candidate = root[key];
      if (typeof candidate === 'string' && candidate) return candidate;
      if (typeof candidate === 'number' && candidate > 1_000_000_000_000) return new Date(candidate).toISOString();
    }
  }
  return new Date().toISOString();
}
function taskId(record: JsonObject): string | undefined { return text(record, ['taskUuid', 'taskUUID', 'id', 'uuid']); }
function safeName(name: string): string { return name.replace(/[\\/:*?"<>|#[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) || '未命名听记'; }
function yaml(value: string): string { return JSON.stringify(value); }
function record(value: unknown): JsonObject { const data = unwrap(value); return isObject(data) ? data : {}; }
function asText(value: unknown): string { return typeof value === 'string' ? value.replace(/\\n/g, '\n').trim() : ''; }
function summarySection(value: unknown): string {
  const data = record(value);
  const body = asText(data.fullSummary) || asText(data.summary) || asText(data.content);
  return body ? `## AI 摘要\n\n${body}` : '';
}
function keywordsSection(value: unknown): string {
  const keywords = record(value).keywords;
  if (!Array.isArray(keywords)) return '';
  const items = keywords.map(asText).filter(Boolean);
  return items.length ? `## 关键词\n\n${items.map(item => `#${item.replace(/\s+/g, '-')}`).join(' ')}` : '';
}
function todosSection(value: unknown): string {
  const data = record(value);
  const actions = Array.isArray(data.actions) ? data.actions : Array.isArray(data.dingtalkTodoList) ? data.dingtalkTodoList : [];
  const items = actions.map(action => {
    if (typeof action === 'string') {
      try { return asText((JSON.parse(action) as JsonObject).value) || action; } catch { return action; }
    }
    return isObject(action) ? asText(action.value) || asText(action.title) : '';
  }).filter(Boolean);
  return items.length ? `## 待办\n\n${items.map(item => `- [ ] ${item}`).join('\n')}` : '';
}
function timestamp(milliseconds: unknown): string {
  const seconds = typeof milliseconds === 'number' ? Math.floor(milliseconds / 1000) : 0;
  return `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds % 3600 / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
function transcriptSection(pages: unknown[], warning = ''): string {
  const paragraphs = pages.flatMap(page => {
    const list = record(page).paragraphList;
    return Array.isArray(list) ? list.filter(isObject) : [];
  });
  const lines = paragraphs.map(paragraph => {
    const speaker = asText(paragraph.nickName) || (isObject(paragraph.speakerDisplay) ? asText(paragraph.speakerDisplay.nickName) : '') || '发言人';
    const content = asText(paragraph.paragraph);
    return content ? `**${speaker}** · ${timestamp(paragraph.startTime)}\n\n${content}` : '';
  }).filter(Boolean);
  if (lines.length) return `## 逐字稿\n\n${lines.join('\n\n---\n\n')}`;
  return warning ? `## 逐字稿\n\n> ${warning}` : '';
}
function renderMarkdown(id: string, record: JsonObject, info: unknown, summary: unknown, keywords: unknown, todos: unknown, transcript: unknown[], transcriptWarning = ''): string {
  const title = text(info, ['title', 'name']) || text(record, ['title', 'name', 'taskName']) || '未命名听记';
  const created = meetingTime(record, info);
  return ['---', 'source: dingtalk-minutes', `taskUuid: ${yaml(id)}`, `title: ${yaml(title)}`, created ? `created: ${yaml(created)}` : '', `synced: ${yaml(new Date().toISOString())}`, 'tags: [钉钉听记, 会议纪要]', '---', '', `# ${title}`, '', summarySection(summary), keywordsSection(keywords), todosSection(todos), transcriptSection(transcript, transcriptWarning)].filter(Boolean).join('\n\n') + '\n';
}
