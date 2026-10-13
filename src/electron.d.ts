export {};
declare global {
  type ResourceKind = 'skill' | 'rule';
  type Resource = { id: string; name: string; sourcePath: string; description: string; category?: string; importedAt: string };
  type Skill = Resource;
  type Rule = Resource;
  type ToolTarget = { id: string; name: string; directory: string; skillDirectory: string; ruleDirectory: string; enabled: boolean };
  type Target = { id: string; name: string; path: string; tools: ToolTarget[]; kind: 'preset' | 'custom'; enabled: boolean };
  type ToolPreset = { name: string; directory: string; skillDirectory: string; ruleDirectory: string; exists: boolean };
  type LinkRecord = { id: string; resourceKind: ResourceKind; resourceId: string; skillId?: string; targetId: string; toolId: string; targetDirectory: string; linkPath: string; createdAt: string };
  type Categories = { skill: string[]; rule: string[] };
  type Store = { skills: Skill[]; rules: Rule[]; targets: Target[]; links: LinkRecord[]; categories: Categories; notes: Record<string, string>; categorySchemaVersion?: number; targetSchemaVersion?: number };
  type FileEntry = { path: string; name: string; type: 'file' | 'directory'; size?: number };
  type LinkSelection = { targetId: string; toolId: string };
  type LinkResult = { resourceId: string; targetId: string; toolId: string; status: 'created' | 'already-linked' | 'conflict' | 'missing-source'; linkPath: string };
  type SessionAgent = 'codex' | 'codebuddy';
  type SessionMessage = { role: 'user' | 'assistant' | 'tool'; text: string; at?: string };
  type SessionSummary = { id: string; agent: SessionAgent; workspacePath: string; workspaceName: string; title: string; updatedAt: string; messageCount: number; hasDetail: boolean; source: string; workspaceNote?: string };
  interface Window { skillManager: {
    list: () => Promise<Store>;
    selectSkillDirectories: () => Promise<string[]>; importSkills: (paths: string[]) => Promise<{ store: Store; added: number }>; updateSkill: (id: string, changes: { category?: string }) => Promise<Store>; removeSkill: (id: string) => Promise<Store>; skillFiles: (id: string) => Promise<FileEntry[]>; readSkillFile: (id: string, file: string) => Promise<string | null>;
    selectRuleFiles: () => Promise<string[]>; importRules: (paths: string[]) => Promise<{ store: Store; added: number }>; updateRule: (id: string, changes: { category?: string }) => Promise<Store>; removeRule: (id: string) => Promise<Store>; ruleFiles: (id: string) => Promise<FileEntry[]>; readRuleFile: (id: string, file: string) => Promise<string | null>;
    createCategory: (kind: ResourceKind, name: string) => Promise<Store>; removeCategory: (kind: ResourceKind, name: string) => Promise<Store>; selectTargetDirectory: () => Promise<string | null>; targetsWorkspacePresets: () => Promise<{ name: string; path: string }[]>; detectTargetsTools: (workspacePath: string) => Promise<ToolPreset[]>; saveTarget: (target: Omit<Target, 'id'> & { id?: string }) => Promise<Store>; removeTarget: (id: string) => Promise<Store>; createLinks: (kind: ResourceKind, resourceIds: string[], selections: LinkSelection[]) => Promise<{ store: Store; results: LinkResult[] }>; removeLink: (id: string) => Promise<Store>; listSessions: () => Promise<SessionSummary[]>; readSession: (agent: SessionAgent, source: string) => Promise<SessionMessage[]>; setWorkspaceNote: (workspacePath: string, note: string) => Promise<Store>;
  } }
}
