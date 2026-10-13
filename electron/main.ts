import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

type ResourceKind = 'skill' | 'rule';
type Resource = { id: string; name: string; sourcePath: string; description: string; category?: string; importedAt: string };
type Skill = Resource;
type Rule = Resource;
type ToolTarget = { id: string; name: string; directory: string; skillDirectory: string; ruleDirectory: string; enabled: boolean };
type Target = { id: string; name: string; path: string; tools: ToolTarget[]; kind: 'preset' | 'custom'; enabled: boolean };
type LegacyTarget = Partial<Target> & { skillDirectory?: string; ruleDirectory?: string };
type LinkRecord = { id: string; resourceKind: ResourceKind; resourceId: string; targetId: string; toolId: string; targetDirectory: string; linkPath: string; createdAt: string };
type LinkSelection = { targetId: string; toolId: string };
type LinkResult = { resourceId: string; targetId: string; toolId: string; status: 'created' | 'already-linked' | 'conflict' | 'missing-source'; linkPath: string };
type Categories = { skill: string[]; rule: string[] };
type Store = { skills: Skill[]; rules: Rule[]; targets: Target[]; links: LinkRecord[]; categories: Categories; notes: Record<string, string>; categorySchemaVersion?: number; targetSchemaVersion?: number };
type FileEntry = { path: string; name: string; type: 'file' | 'directory'; size?: number };

const toolPresets: Array<Omit<ToolTarget, 'id' | 'enabled'>> = [
  { name: 'Claude Code', directory: '.claude', skillDirectory: 'skills', ruleDirectory: 'rules' },
  { name: 'Codex', directory: '.codex', skillDirectory: 'skills', ruleDirectory: 'rules' },
  { name: 'Cursor', directory: '.cursor', skillDirectory: 'skills', ruleDirectory: 'rules' },
  { name: 'CodeBuddy', directory: '.codebuddy', skillDirectory: 'skills', ruleDirectory: 'rules' },
];
const storePath = () => path.join(app.getPath('userData'), 'locra.json');
const normalizeToolDirectory = (value: string | undefined) => {
  const normalized = (value || '').trim().replace(/^[/\\]+|[/\\]+$/g, '');
  if (!normalized || normalized === '.') return '';
  if (path.isAbsolute(normalized) || normalized.split(/[\\/]/).includes('..')) throw new Error('工具目录必须是工作空间下的相对路径');
  return normalized;
};
const normalizeResourceDirectory = (value: string | undefined, fallback: string) => {
  const normalized = (value || fallback).trim().replace(/^[/\\]+|[/\\]+$/g, '');
  if (!normalized || path.isAbsolute(normalized) || normalized.split(/[\\/]/).includes('..')) throw new Error('资源目录必须是相对根目录的有效路径');
  return normalized;
};
const normalizeTool = (tool: Partial<ToolTarget>, index = 0): ToolTarget => ({
  id: tool.id || randomUUID(),
  name: (tool.name || '').trim() || `工具 ${index + 1}`,
  directory: normalizeToolDirectory(tool.directory),
  skillDirectory: normalizeResourceDirectory(tool.skillDirectory, 'skills'),
  ruleDirectory: normalizeResourceDirectory(tool.ruleDirectory, 'rules'),
  enabled: tool.enabled !== false,
});
const toolRoot = (target: Target, tool: ToolTarget) => tool.directory ? path.join(target.path, tool.directory) : target.path;
const resourceDirectory = (target: Target, tool: ToolTarget, kind: ResourceKind) => path.join(toolRoot(target, tool), kind === 'skill' ? tool.skillDirectory : tool.ruleDirectory);
const resourceLinkPath = (target: Target, tool: ToolTarget, kind: ResourceKind, resource: Resource) => path.join(resourceDirectory(target, tool, kind), kind === 'rule' ? path.basename(resource.sourcePath) : resource.name);
const resourcesOf = (store: Store, kind: ResourceKind) => kind === 'skill' ? store.skills : store.rules;
const toolOf = (target: Target | undefined, toolId: string) => target?.tools.find((tool) => tool.id === toolId);

async function readStore(): Promise<Store> {
  try {
    const raw = JSON.parse(await fs.readFile(storePath(), 'utf8')) as Partial<Store> & { links?: Array<Partial<LinkRecord> & { skillId?: string }> };
    const legacyCategories = Array.isArray(raw.categories) ? raw.categories : [];
    const categories = Array.isArray(raw.categories) ? { skill: [...legacyCategories], rule: [] } : { skill: raw.categories?.skill ?? [], rule: raw.categories?.rule ?? [] };
    let targetSchemaChanged = raw.targetSchemaVersion !== 3;
    const legacyRemap = new Map<string, { targetId: string; toolId: string }>();
    const targets: Target[] = [];
    const candidates: Array<{ legacyId: string; workspace: string; kind: Target['kind']; enabled: boolean; tool: ToolTarget }> = [];
    for (const rawTarget of raw.targets ?? []) {
      const legacy = rawTarget as LegacyTarget;
      const legacyId = legacy.id; const legacyPath = legacy.path; const legacyName = legacy.name;
      if (!legacyId || !legacyName || !legacyPath) continue;
      const kind: Target['kind'] = legacy.kind === 'preset' ? 'preset' : 'custom';
      const name = legacyName.trim();
      const resolved = path.resolve(legacyPath.trim());
      const legacyTools = legacy.tools;
      if (Array.isArray(legacyTools) && legacyTools.length) {
        const tools = legacyTools.map((tool, index) => normalizeTool(tool, index));
        if (!tools.every((tool, index) => { const previous = legacyTools[index]; return tool.id === previous.id && tool.name === previous.name && tool.directory === previous.directory && tool.skillDirectory === previous.skillDirectory && tool.ruleDirectory === previous.ruleDirectory; })) targetSchemaChanged = true;
        // 单工具且直接指向工作空间下的已知工具目录时，并入所属工作空间
        const preset = tools.length === 1 && !tools[0].directory ? toolPresets.find((item) => item.directory === path.basename(resolved)) : undefined;
        if (preset) { candidates.push({ legacyId, workspace: path.dirname(resolved), kind, enabled: legacy.enabled !== false, tool: { ...tools[0], name: preset.name, directory: preset.directory } }); targetSchemaChanged = true; }
        else targets.push({ id: legacyId, name, path: resolved, tools, kind, enabled: legacy.enabled !== false });
        continue;
      }
      // 旧格式：一个目标就是一个工具根目录，按父目录归并到同一个工作空间
      const preset = toolPresets.find((item) => item.directory === path.basename(resolved));
      const tool: ToolTarget = { id: randomUUID(), name: preset ? preset.name : name, directory: preset ? preset.directory : '', skillDirectory: normalizeResourceDirectory(legacy.skillDirectory, 'skills'), ruleDirectory: normalizeResourceDirectory(legacy.ruleDirectory, 'rules'), enabled: legacy.enabled !== false };
      targetSchemaChanged = true;
      if (preset) candidates.push({ legacyId, workspace: path.dirname(resolved), kind, enabled: legacy.enabled !== false, tool });
      else { targets.push({ id: legacyId, name, path: resolved, tools: [tool], kind, enabled: legacy.enabled !== false }); legacyRemap.set(legacyId, { targetId: legacyId, toolId: tool.id }); }
    }
    const grouped = new Map<string, { kind: Target['kind']; enabled: boolean; tools: ToolTarget[]; legacyIds: string[] }>();
    for (const candidate of candidates) {
      const group = grouped.get(candidate.workspace) ?? { kind: candidate.kind, enabled: false, tools: [], legacyIds: [] };
      if (!group.tools.some((item) => item.directory === candidate.tool.directory)) {
        group.tools.push(candidate.tool);
        group.legacyIds.push(candidate.legacyId);
        legacyRemap.set(candidate.legacyId, { targetId: '', toolId: candidate.tool.id });
      }
      group.enabled = group.enabled || candidate.enabled;
      grouped.set(candidate.workspace, group);
    }
    for (const [workspace, group] of grouped) {
      const targetId = randomUUID();
      for (const legacyId of group.legacyIds) legacyRemap.set(legacyId, { targetId, toolId: legacyRemap.get(legacyId)!.toolId });
      targets.push({ id: targetId, name: path.basename(workspace), path: workspace, tools: group.tools, kind: group.kind, enabled: group.enabled });
    }
    const store: Store = {
      skills: raw.skills ?? [], rules: raw.rules ?? [], targets,
      links: (raw.links ?? []).flatMap((link) => {
        const legacy = link as Partial<LinkRecord> & { skillId?: string };
        const resourceId = legacy.resourceId ?? legacy.skillId;
        if (!resourceId || !legacy.targetId || !legacy.linkPath) return [];
        const mapping = legacy.toolId ? { targetId: legacy.targetId, toolId: legacy.toolId } : legacyRemap.get(legacy.targetId);
        if (!mapping) return [];
        return [{ ...legacy, resourceKind: legacy.resourceKind ?? 'skill', resourceId, targetId: mapping.targetId, toolId: mapping.toolId, targetDirectory: legacy.targetDirectory ?? '', createdAt: legacy.createdAt ?? new Date().toISOString() } as LinkRecord];
      }),
      categories,
      notes: raw.notes ?? {},
      categorySchemaVersion: raw.categorySchemaVersion,
    };
    const copiedRuleCategories = !raw.categorySchemaVersion && !store.rules.length && categories.rule.length === categories.skill.length && categories.rule.every((item) => categories.skill.includes(item));
    if (copiedRuleCategories) store.categories.rule = [];
    store.categorySchemaVersion = 2;
    store.targetSchemaVersion = 3;
    let changed = targetSchemaChanged || Boolean(!raw.rules || Array.isArray(raw.categories) || copiedRuleCategories || raw.categorySchemaVersion !== 2 || (raw.links ?? []).some((link) => !link.resourceKind || !link.toolId));
    for (const kind of ['skill', 'rule'] as ResourceKind[]) for (const resource of resourcesOf(store, kind)) if (resource.category && !store.categories[kind].includes(resource.category)) { store.categories[kind].push(resource.category); changed = true; }
    if (changed) await writeStore(store);
    return store;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { skills: [], rules: [], targets: [], links: [], categories: { skill: [], rule: [] }, notes: {} };
    throw error;
  }
}
async function writeStore(store: Store) { await fs.writeFile(storePath(), JSON.stringify(store, null, 2), 'utf8'); }
async function readMetadata(sourcePath: string, kind: ResourceKind) {
  const file = kind === 'skill' ? path.join(sourcePath, 'SKILL.md') : sourcePath;
  try {
    const content = await fs.readFile(file, 'utf8'); const frontmatter = content.match(/^---\s*\n([\s\S]*?)\n---/);
    return { name: frontmatter?.[1].match(/^name:\s*["']?(.+?)["']?\s*$/m)?.[1], description: frontmatter?.[1].match(/^description:\s*["']?(.+?)["']?\s*$/m)?.[1] ?? content.split('\n').find((line) => line.trim() && !line.startsWith('#') && !line.startsWith('---'))?.trim() ?? '' };
  } catch { return { description: '' }; }
}
async function listFiles(root: string, current = root, depth = 0): Promise<FileEntry[]> {
  if (depth > 3) return []; const entries = await fs.readdir(current, { withFileTypes: true }); const result: FileEntry[] = [];
  for (const entry of entries.filter((item) => !item.name.startsWith('.')).sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))) { const fullPath = path.join(current, entry.name); const relativePath = path.relative(root, fullPath); if (entry.isDirectory()) result.push({ path: relativePath, name: entry.name, type: 'directory' }, ...(await listFiles(root, fullPath, depth + 1))); else { const stat = await fs.stat(fullPath); result.push({ path: relativePath, name: entry.name, type: 'file', size: stat.size }); } }
  return result;
}
// ── 软链接：macOS/Linux 用符号链接；Windows 建符号链接需要管理员权限或开发者模式，
// 所以目录走 junction（无需特权），文件建链失败时退化为复制，保证同步在各平台都能用 ──
async function createLink(source: string, linkPath: string, kind: ResourceKind) {
  const type = kind === 'skill' ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file';
  try {
    await fs.symlink(source, linkPath, type);
  } catch (error) {
    if (process.platform !== 'win32') throw error;
    if ((await fs.stat(source)).isDirectory()) await fs.cp(source, linkPath, { recursive: true });
    else await fs.copyFile(source, linkPath);
  }
}
// 判断 linkPath 是否已经指向 source：软链接比对真实路径，Windows 上复制出来的副本按 store 里的记录认定
async function isLinkedTo(linkPath: string, source: string, recorded: boolean) {
  try {
    const info = await fs.lstat(linkPath);
    if (info.isSymbolicLink()) return (await fs.realpath(linkPath)) === (await fs.realpath(source));
    return process.platform === 'win32' && recorded;
  } catch { return false; }
}
async function removeLinkPath(linkPath: string) {
  try {
    const info = await fs.lstat(linkPath);
    if (!info.isSymbolicLink() && info.isDirectory()) await fs.rm(linkPath, { recursive: true, force: true });
    else await fs.unlink(linkPath);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
async function reconcileLinks(store: Store) {
  const valid: LinkRecord[] = [];
  for (const target of store.targets) for (const tool of target.tools) for (const kind of ['skill', 'rule'] as ResourceKind[]) for (const resource of resourcesOf(store, kind)) {
    const linkPath = resourceLinkPath(target, tool, kind, resource);
    const existing = store.links.find((link) => link.resourceKind === kind && link.resourceId === resource.id && link.targetId === target.id && link.toolId === tool.id);
    try { if (!(await isLinkedTo(linkPath, resource.sourcePath, Boolean(existing)))) continue; valid.push(existing ? { ...existing, targetDirectory: resourceDirectory(target, tool, kind), linkPath } : { id: randomUUID(), resourceKind: kind, resourceId: resource.id, targetId: target.id, toolId: tool.id, targetDirectory: resourceDirectory(target, tool, kind), linkPath, createdAt: new Date().toISOString() }); } catch { /* ignore */ }
  }
  const changed = valid.length !== store.links.length || valid.some((link) => !store.links.some((old) => old.id === link.id && old.linkPath === link.linkPath)); if (changed) store.links = valid; return changed;
}
async function readReconciledStore() { const store = await readStore(); if (await reconcileLinks(store)) await writeStore(store); return store; }
async function removeResource(store: Store, kind: ResourceKind, resourceId: string) { const links = store.links.filter((link) => link.resourceKind === kind && link.resourceId === resourceId); for (const link of links) await removeLinkPath(link.linkPath); if (kind === 'skill') store.skills = store.skills.filter((item) => item.id !== resourceId); else store.rules = store.rules.filter((item) => item.id !== resourceId); store.links = store.links.filter((link) => link.resourceId !== resourceId || link.resourceKind !== kind); }
async function removeLinkFiles(links: LinkRecord[]) { for (const link of links) await removeLinkPath(link.linkPath); }

// ── 会话记录：汇总各 Agent 在工作空间下的对话历史 ──
type SessionAgent = 'codex' | 'codebuddy';
type SessionRole = 'user' | 'assistant' | 'tool';
type SessionMessage = { role: SessionRole; text: string; at?: string };
type SessionSummary = { id: string; agent: SessionAgent; workspacePath: string; workspaceName: string; title: string; updatedAt: string; messageCount: number; hasDetail: boolean; source: string; workspaceNote?: string };
type ParsedSession = { cwd: string; sessionId: string; title: string; messageCount: number; updatedAt: string; messages: SessionMessage[] };

const homeDir = () => process.env.HOME || app.getPath('home');
// 各平台的用户配置目录：macOS 是 ~/Library/Application Support，Windows 是 %APPDATA%，避免写死单一平台
const appDataDir = () => app.getPath('appData');
function agentRoot(agent: SessionAgent) {
  const home = homeDir();
  if (agent === 'codex') return path.join(home, '.codex');
  return path.join(appDataDir(), 'CodeBuddy CN', 'User', 'globalStorage', 'tencent-cloud.coding-copilot');
}

async function listNames(dir: string) { try { return await fs.readdir(dir); } catch { return [] as string[]; } }
async function statOf(file: string) { try { return await fs.stat(file); } catch { return null; } }

async function collectFiles(dir: string, depth: number, match: (name: string) => boolean) {
  const found: string[] = [];
  const walk = async (current: string, level: number) => {
    if (level > depth) return;
    for (const entry of await listNames(current)) {
      const full = path.join(current, entry);
      const info = await statOf(full);
      if (!info) continue;
      if (info.isDirectory()) await walk(full, level + 1);
      else if (match(entry)) found.push(full);
    }
  };
  await walk(dir, 0);
  return found;
}

async function readJsonLines(file: string) {
  let text = '';
  try { text = await fs.readFile(file, 'utf8'); } catch { return [] as Record<string, unknown>[]; }
  const items: Record<string, unknown>[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { const parsed = JSON.parse(trimmed); if (parsed && typeof parsed === 'object') items.push(parsed as Record<string, unknown>); } catch { /* 忽略不完整行 */ }
  }
  return items;
}

const cleanTitle = (value: string) => value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);

function matchWorkspace(cwd: string, targets: Target[]) {
  const normalized = cwd.replace(/^file:\/\//, '').replace(/\/+$/, '');
  if (!normalized) return null;
  let matched: Target | null = null;
  for (const target of targets) {
    if (normalized !== target.path && !normalized.startsWith(`${target.path}/`)) continue;
    if (!matched || target.path.length > matched.path.length) matched = target;
  }
  return matched;
}

const textParts = (content: unknown) => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => { const record = part as Record<string, unknown> | null; return record && typeof record.text === 'string' ? record.text : ''; }).filter(Boolean).join('\n');
};

function parseCodex(items: Record<string, unknown>[], withMessages: boolean): ParsedSession {
  const parsed: ParsedSession = { cwd: '', sessionId: '', title: '', messageCount: 0, updatedAt: '', messages: [] };
  for (const item of items) {
    const payload = (item.payload ?? {}) as Record<string, unknown>;
    const lineAt = String(item.timestamp ?? '');
    if (lineAt) parsed.updatedAt = lineAt;
    if (item.type === 'session_meta') {
      parsed.cwd = String(payload.cwd ?? parsed.cwd);
      parsed.sessionId = String(payload.session_id ?? payload.id ?? parsed.sessionId);
      parsed.updatedAt = String(payload.timestamp ?? parsed.updatedAt);
      continue;
    }
    if (item.type !== 'response_item' || payload.type !== 'message') continue;
    const role = String(payload.role ?? '');
    if (role !== 'user' && role !== 'assistant') continue;
    const text = textParts(payload.content);
    if (!text) continue;
    if (role === 'user' && !parsed.title) parsed.title = text;
    parsed.messageCount++;
    if (withMessages) parsed.messages.push({ role: role === 'user' ? 'user' : 'assistant', text, at: lineAt });
  }
  return parsed;
}

async function listSessions(): Promise<SessionSummary[]> {
  const store = await readStore();
  const targets = store.targets.filter((target) => target.enabled !== false);
  const found: SessionSummary[] = [];
  await Promise.all([collectCodex(targets, found), collectCodeBuddy(targets, found)]);
  // id 会作为渲染层的 key，必须全局唯一，否则 React 会残留上一个工作空间的行
  const seen = new Map<string, number>();
  return found.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')).map((item) => {
    const count = (seen.get(item.id) ?? 0) + 1;
    seen.set(item.id, count);
    const session: SessionSummary = { ...item, workspaceNote: store.notes[item.workspacePath] ?? '' };
    return count === 1 ? session : { ...session, id: `${item.id}#${count}` };
  });
}

// Codex 自己维护 state_N.sqlite 的 threads 表（title/cwd/archived/updated_at/rollout_path），
// 与它的会话列表完全一致，所以优先读它，读不到再回退到扫描 rollout 文件
type CodexThreadRow = { id?: unknown; name?: unknown; title?: unknown; first_user_message?: unknown; cwd?: unknown; updated_at?: unknown; rollout_path?: unknown };

async function readCodexThreads(root: string) {
  const files = (await listNames(root)).filter((name) => /^state_\d+\.sqlite$/.test(name)).sort((a, b) => Number((b.match(/\d+/) ?? ['0'])[0]) - Number((a.match(/\d+/) ?? ['0'])[0]));
  if (!files.length) return [] as CodexThreadRow[];
  try {
    const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (target: string, options?: { readOnly?: boolean }) => { prepare: (sql: string) => { all: () => unknown[] }; close: () => void } };
    const database = new DatabaseSync(path.join(root, files[0]), { readOnly: true });
    try {
      // source 里带 subagent 的是主线程派生的子代理（如 01a12fb1 由 01a12f31 派生），
      // Codex 自己的会话列表不列它，否则会把子代理的正文当成一个独立会话显示
      return database.prepare("select id, name, title, first_user_message, cwd, updated_at, rollout_path from threads where archived = 0 and (source is null or source not like '%subagent%')").all() as CodexThreadRow[];
    } finally { database.close(); }
  } catch { return [] as CodexThreadRow[]; }
}

async function collectCodex(targets: Target[], found: SessionSummary[]) {
  const root = agentRoot('codex');
  const rows = await readCodexThreads(root);
  if (rows.length) {
    for (const row of rows) {
      const target = matchWorkspace(String(row.cwd ?? ''), targets);
      if (!target) continue;
      const source = String(row.rollout_path ?? '');
      const parsed = source ? parseCodex(await readJsonLines(source), false) : null;
      const title = cleanTitle(String(row.name ?? '')) || cleanTitle(String(row.first_user_message ?? '')) || cleanTitle(String(row.title ?? '')) || cleanTitle(parsed?.title ?? '');
      if (!title) continue;
      const updatedAt = Number(row.updated_at) > 0 ? new Date(Number(row.updated_at) * 1000).toISOString() : (parsed?.updatedAt ?? '');
      found.push({ id: `codex:${target.path}::${String(row.id ?? source)}`, agent: 'codex', workspacePath: target.path, workspaceName: target.name, title, updatedAt, messageCount: parsed?.messageCount ?? 0, hasDetail: Boolean(parsed && parsed.messageCount), source });
    }
    return;
  }
  const titles = new Map<string, string>();
  for (const item of await readJsonLines(path.join(root, 'session_index.jsonl'))) {
    const id = String(item.id ?? '');
    const title = String(item.thread_name ?? '');
    if (id && title) titles.set(id, title);
  }
  // 回退方案：同一个 thread 会被 Codex 续写成多份 rollout 文件（session_id 相同），按 thread 归并，只保留最新一段
  const threads = new Map<string, SessionSummary>();
  for (const file of await collectFiles(path.join(root, 'sessions'), 4, (name) => name.startsWith('rollout-') && name.endsWith('.jsonl'))) {
    const parsed = parseCodex(await readJsonLines(file), false);
    const target = matchWorkspace(parsed.cwd, targets);
    if (!target) continue;
    const info = await statOf(file);
    const updatedAt = parsed.updatedAt || (info ? info.mtime.toISOString() : '');
    const key = `${target.path}::${parsed.sessionId || path.basename(file)}`;
    const existing = threads.get(key);
    if (existing && existing.updatedAt >= updatedAt) continue;
    threads.set(key, { id: `codex:${key}`, agent: 'codex', workspacePath: target.path, workspaceName: target.name, title: cleanTitle(titles.get(parsed.sessionId) ?? '') || cleanTitle(parsed.title) || '未命名会话', updatedAt, messageCount: parsed.messageCount, hasDetail: true, source: file });
  }
  found.push(...threads.values());
}

// CodeBuddy 的会话清单（名字/时间/工作目录）在 codebuddy-sessions.vscdb 的 ItemTable 里：
// key 是 session:<会话id>，value 是含 cwd/title/customTitle/createdAt/updatedAt 的 JSON。
// genie-history/<base64 路径>/current.json 只是"当前会话"指针，只读它每个工作空间最多出一条且没有名字
type CodeBuddySessionRow = { conversationId?: unknown; cwd?: unknown; title?: unknown; customTitle?: unknown; updatedAt?: unknown };

async function readCodeBuddySessions() {
  const file = path.join(appDataDir(), 'CodeBuddy CN', 'codebuddy-sessions.vscdb');
  const sessions: CodeBuddySessionRow[] = [];
  try {
    const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (target: string, options?: { readOnly?: boolean }) => { prepare: (sql: string) => { all: () => unknown[] }; close: () => void } };
    const database = new DatabaseSync(file, { readOnly: true });
    try {
      for (const row of database.prepare("select value from ItemTable where key like 'session:%'").all() as { value?: unknown }[]) {
        try { sessions.push(JSON.parse(String(row.value ?? '')) as CodeBuddySessionRow); } catch { /* 单条坏了跳过 */ }
      }
    } finally { database.close(); }
  } catch { /* 读不到就让下面退回 current.json */ }
  return sessions;
}

async function collectCodeBuddy(targets: Target[], found: SessionSummary[]) {
  const sessions = await readCodeBuddySessions();
  for (const session of sessions) {
    const target = matchWorkspace(String(session.cwd ?? ''), targets);
    if (!target) continue;
    const title = cleanTitle(String(session.customTitle ?? '')) || cleanTitle(String(session.title ?? ''));
    if (!title) continue;
    const updatedAt = Number(session.updatedAt) > 0 ? new Date(Number(session.updatedAt)).toISOString() : '';
    found.push({ id: `codebuddy:${String(session.conversationId ?? '')}`, agent: 'codebuddy', workspacePath: target.path, workspaceName: target.name, title, updatedAt, messageCount: 0, hasDetail: false, source: '' });
  }
  if (sessions.length) return;
  const dir = path.join(agentRoot('codebuddy'), 'genie-history');
  for (const entry of await listNames(dir)) {
    let decoded = '';
    try { decoded = Buffer.from(entry.replace(/_+$/, (match) => '='.repeat(match.length)).replace(/-/g, '+'), 'base64').toString('utf8'); } catch { continue; }
    const target = matchWorkspace(decoded, targets);
    if (!target) continue;
    const file = path.join(dir, entry, 'current.json');
    const info = await statOf(file);
    if (!info) continue;
    let conversationId = '';
    let lastUpdated = '';
    try { const content = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>; conversationId = String(content.conversationId ?? ''); lastUpdated = String(content.lastUpdated ?? ''); } catch { /* 忽略 */ }
    found.push({ id: `codebuddy:${conversationId || entry}`, agent: 'codebuddy', workspacePath: target.path, workspaceName: target.name, title: conversationId ? `会话 ${conversationId.slice(0, 8)}` : '当前会话', updatedAt: lastUpdated || info.mtime.toISOString(), messageCount: 0, hasDetail: false, source: '' });
  }
}

async function readSessionMessages(agent: SessionAgent, source: string) {
  if (!source) return [] as SessionMessage[];
  const root = path.resolve(agentRoot(agent));
  const file = path.resolve(source);
  if (file !== root && !file.startsWith(`${root}${path.sep}`)) return [] as SessionMessage[];
  const items = await readJsonLines(file);
  const messages = agent === 'codex' ? parseCodex(items, true).messages : [];
  return messages.slice(-400).map((message) => ({ ...message, text: message.text.length > 6000 ? `${message.text.slice(0, 6000)}\n…（内容过长已截断）` : message.text }));
}

function createWindow() { const window = new BrowserWindow({ width: 1280, height: 820, minWidth: 1000, minHeight: 680, titleBarStyle: 'hiddenInset', webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false } }); const devServerUrl = process.env.VITE_DEV_SERVER_URL; if (devServerUrl) window.loadURL(devServerUrl); else window.loadFile(path.join(__dirname, '../dist/index.html')); }
app.whenReady().then(() => {
  ipcMain.handle('store:list', readReconciledStore);
  for (const kind of ['skill', 'rule'] as ResourceKind[]) {
    const plural = kind === 'skill' ? 'skills' : 'rules';
    ipcMain.handle(`${plural}:select-${kind === 'skill' ? 'directories' : 'files'}`, async () => { const result = await dialog.showOpenDialog(kind === 'skill' ? { properties: ['openDirectory', 'multiSelections'] } : { properties: ['openFile', 'multiSelections'], filters: [{ name: 'Cursor Rule', extensions: ['mdc'] }] }); return result.canceled ? [] : result.filePaths; });
    ipcMain.handle(`${plural}:import`, async (_event, sourcePaths: string[]) => { const store = await readStore(); const resources = resourcesOf(store, kind); let added = 0; for (const sourcePath of sourcePaths) { const stat = await fs.stat(sourcePath).catch(() => null); if (resources.some((item) => item.sourcePath === sourcePath) || !stat || (kind === 'skill' ? !stat.isDirectory() : !stat.isFile() || path.extname(sourcePath).toLowerCase() !== '.mdc')) continue; const meta = await readMetadata(sourcePath, kind); resources.push({ id: randomUUID(), name: meta.name || path.basename(sourcePath, kind === 'rule' ? '.mdc' : undefined), sourcePath, description: meta.description, importedAt: new Date().toISOString() }); added++; } await writeStore(store); return { store, added }; });
    ipcMain.handle(`${plural}:update`, async (_event, id: string, changes: Pick<Resource, 'category'>) => { const store = await readStore(); const resource = resourcesOf(store, kind).find((item) => item.id === id); if (!resource) throw new Error(`${kind === 'skill' ? 'Skill' : 'Rule'} 不存在`); resource.category = changes.category?.trim() || undefined; if (resource.category && !store.categories[kind].includes(resource.category)) store.categories[kind].push(resource.category); await writeStore(store); return store; });
    ipcMain.handle(`${plural}:remove`, async (_event, id: string) => { const store = await readStore(); await removeResource(store, kind, id); await writeStore(store); return store; });
    ipcMain.handle(`${plural}:files`, async (_event, id: string) => { const resource = resourcesOf(await readStore(), kind).find((item) => item.id === id); if (!resource) return []; if (kind === 'rule') { const stat = await fs.stat(resource.sourcePath).catch(() => null); return stat?.isFile() ? [{ path: path.basename(resource.sourcePath), name: path.basename(resource.sourcePath), type: 'file' as const, size: stat.size }] : []; } return listFiles(resource.sourcePath); });
    ipcMain.handle(`${plural}:read-file`, async (_event, id: string, relativePath: string) => { const resource = resourcesOf(await readStore(), kind).find((item) => item.id === id); if (!resource || !relativePath || path.isAbsolute(relativePath) || relativePath.split(path.sep).includes('..')) return null; const fullPath = kind === 'rule' ? resource.sourcePath : path.join(resource.sourcePath, relativePath); const stat = await fs.stat(fullPath); return !stat.isFile() || stat.size > 512 * 1024 ? null : fs.readFile(fullPath, 'utf8'); });
  }
  ipcMain.handle('categories:create', async (_event, kind: ResourceKind, value: string) => { const store = await readStore(); const category = value.trim(); if (!category) throw new Error('分类名称不能为空'); if (!store.categories[kind].includes(category)) store.categories[kind].push(category); await writeStore(store); return store; });
  ipcMain.handle('categories:remove', async (_event, kind: ResourceKind, value: string) => { const store = await readStore(); const category = value.trim(); if (!category) throw new Error('分类名称不能为空'); store.categories[kind] = store.categories[kind].filter((item) => item !== category); for (const resource of resourcesOf(store, kind)) if (resource.category === category) resource.category = undefined; await writeStore(store); return store; });
  ipcMain.handle('targets:select-directory', async () => { const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] }); return result.canceled ? null : result.filePaths[0]; });
  ipcMain.handle('targets:workspace-presets', () => [{ name: '主目录', path: app.getPath('home') }]);
  ipcMain.handle('targets:detect-tools', async (_event, workspacePath: string) => {
    const root = path.resolve((workspacePath || '').trim() || app.getPath('home'));
    return Promise.all(toolPresets.map(async (preset) => ({ ...preset, exists: await fs.stat(path.join(root, preset.directory)).then((stat) => stat.isDirectory()).catch(() => false) })));
  });
  ipcMain.handle('targets:save', async (_event, target: Omit<Target, 'id'> & { id?: string }) => {
    const store = await readStore();
    if (!target.name?.trim() || !target.path?.trim()) throw new Error('工作空间名称和路径不能为空');
    const tools = (target.tools ?? []).map((tool, index) => normalizeTool(tool, index));
    if (!tools.length) throw new Error('请至少勾选一个工具目录');
    const signatures = tools.map((tool) => `${tool.directory}|${tool.skillDirectory}|${tool.ruleDirectory}`);
    if (new Set(signatures).size !== signatures.length) throw new Error('存在重复的工具目录配置');
    const next: Target = { id: target.id || randomUUID(), name: target.name.trim(), path: path.resolve(target.path.trim()), tools, kind: target.kind === 'preset' ? 'preset' : 'custom', enabled: target.enabled !== false };
    const duplicated = store.targets.find((item) => item.id !== next.id && item.path === next.path);
    if (duplicated) throw new Error(`该路径已被工作空间「${duplicated.name}」使用`);
    const nextRoots = next.tools.map((tool) => toolRoot(next, tool));
    const overlapped = store.targets.find((item) => item.id !== next.id && item.tools.some((tool) => nextRoots.includes(toolRoot(item, tool))));
    if (overlapped) throw new Error(`工具目录与工作空间「${overlapped.name}」重复，请先调整或删除该工作空间`);
    const index = store.targets.findIndex((item) => item.id === next.id);
    if (index >= 0) store.targets[index] = next; else store.targets.push(next);
    const keptToolIds = new Set(tools.map((tool) => tool.id));
    const droppedLinks = store.links.filter((link) => link.targetId === next.id && !keptToolIds.has(link.toolId));
    await removeLinkFiles(droppedLinks);
    store.links = store.links.filter((link) => link.targetId !== next.id || keptToolIds.has(link.toolId));
    await reconcileLinks(store);
    await writeStore(store);
    return store;
  });
  ipcMain.handle('targets:remove', async (_event, id: string) => { const store = await readStore(); const removed = store.links.filter((item) => item.targetId === id); await removeLinkFiles(removed); store.targets = store.targets.filter((item) => item.id !== id); store.links = store.links.filter((item) => item.targetId !== id); await writeStore(store); return store; });
  ipcMain.handle('links:create', async (_event, kind: ResourceKind, resourceIds: string[], selections: LinkSelection[]) => {
    const store = await readReconciledStore();
    const results: LinkResult[] = [];
    for (const selection of selections) {
      const target = store.targets.find((item) => item.id === selection.targetId);
      const tool = toolOf(target, selection.toolId);
      if (!target || !tool) continue;
      for (const resource of resourcesOf(store, kind).filter((item) => resourceIds.includes(item.id))) {
        const directory = resourceDirectory(target, tool, kind);
        const linkPath = resourceLinkPath(target, tool, kind, resource);
        try { await fs.access(resource.sourcePath); } catch { results.push({ resourceId: resource.id, targetId: target.id, toolId: tool.id, status: 'missing-source', linkPath }); continue; }
        await fs.mkdir(directory, { recursive: true });
        let occupied = true;
        try { await fs.lstat(linkPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; occupied = false; }
        if (occupied) {
          results.push({ resourceId: resource.id, targetId: target.id, toolId: tool.id, status: (await isLinkedTo(linkPath, resource.sourcePath, store.links.some((item) => item.linkPath === linkPath))) ? 'already-linked' : 'conflict', linkPath });
          continue;
        }
        await createLink(resource.sourcePath, linkPath, kind);
        store.links.push({ id: randomUUID(), resourceKind: kind, resourceId: resource.id, targetId: target.id, toolId: tool.id, targetDirectory: directory, linkPath, createdAt: new Date().toISOString() });
        results.push({ resourceId: resource.id, targetId: target.id, toolId: tool.id, status: 'created', linkPath });
      }
    }
    await writeStore(store);
    return { store, results };
  });
  ipcMain.handle('links:remove', async (_event, id: string) => { const store = await readStore(); const link = store.links.find((item) => item.id === id); if (link) { await removeLinkPath(link.linkPath); store.links = store.links.filter((item) => item.id !== id); await writeStore(store); } return store; });
  ipcMain.handle('sessions:list', async () => listSessions());
  ipcMain.handle('sessions:read', async (_event, agent: SessionAgent, source: string) => readSessionMessages(agent, source));
  // 工作空间备注：按工作空间路径存，留空即删除
  ipcMain.handle('notes:set', async (_event, workspacePath: string, note: string) => { const store = await readStore(); const trimmed = note.trim(); if (trimmed) store.notes[workspacePath] = trimmed; else delete store.notes[workspacePath]; await writeStore(store); return store; });
  createWindow(); app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
