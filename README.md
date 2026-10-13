# Locra

把散落在磁盘上的 Skill / Rule 统一收进一个地方管理，再以**软链接**投放到各个 AI 编码 Agent 的目录；
同时汇总浏览本机各 Agent 的会话记录。

技术栈：Electron 44 · React · TypeScript · Vite · electron-builder

---

## 功能

### 1. Skill / Rule 管理
- 导入含 `SKILL.md` 的本地 Skill 目录，以及 `.md` / `.mdc` 的 Rule 文件
- 浏览描述、文件树与文件内容
- 分类与筛选（新建分类 / 未分类 / 全部），支持关键字搜索

### 2. 同步到 Agent（软链接投放）
- 预置目标：Claude Code（`.claude`）、Codex（`.codex`）、Cursor（`.cursor`）、CodeBuddy，也可添加自定义目录
- 单个或批量投放、移除，每个目标实时显示状态（已链接 / 冲突）
- 用软链接指向源目录，改一处对所有 Agent 立刻生效，不复制文件

### 3. 会话浏览
- 汇总本机 **Codex / Claude Code / CodeBuddy** 的会话记录
- 按工作空间归集为卡片，两列排布、按名字排序；单卡片最多显示 5 条，更多在卡片内部滚动，不挤动其它卡片
- 每行显示标题、Agent、时间、消息数；读取不到正文时标注「无本地正文」

### 4. 工作空间
- 维护预置与自定义工作空间（路径、启用的工具），会话按此归集

---

## 安装（macOS / Apple Silicon）

**要求**：macOS 13.0 或更新、Apple Silicon（arm64）。

1. 从 [Releases](https://github.com/whb123456/locra/releases) 下载 `Locra-0.1.0-arm64.dmg`
2. 双击打开，把 **Locra** 拖进「应用程序」

### 首次启动：未签名，会被 macOS 拦下

当前包**没有做代码签名，也没有公证**（机器上没有可用的 Developer ID 证书，打包日志会打印
`skipped macOS application code signing`），所以首次打开会提示「来自身份不明的开发者」，
个别情况下还会提示「已损坏，无法打开」——两者都是同一个隔离属性造成的。

任选一种方式放行：

**方式一：命令行（推荐，一条命令解决）**

```bash
xattr -dr com.apple.quarantine /Applications/Locra.app
```

执行后再双击即可正常启动。若应用不在「应用程序」目录，把路径换成实际位置，例如：

```bash
xattr -dr com.apple.quarantine ~/Downloads/Locra.app
```

**方式二：图形界面**

Finder 里按住 `Control` 点击（或右键）Locra → 「打开」→ 在弹窗里再点一次「打开」。
之后双击就不会再拦。

**方式三：系统设置里放行**

「系统设置 → 隐私与安全性」→ 拉到底部会看到被阻止的提示 → 点「仍要打开」。

> 如果提示「已损坏」且上面方式都不行，说明文件被加上了隔离属性又无法验证：
> `sudo xattr -cr /Applications/Locra.app` 之后再执行方式一的命令即可。

**Intel Mac**：仓库目前只产出 arm64 包。在自己机器上打 x64 包：

```bash
npx electron-builder --mac dmg --x64
```

或把 `package.json` 里 `package:mac` 的 `--arm64` 改成 `--x64`（也能用 `--universal` 出通用包，体积约翻倍）。

---

## 安装（Windows）

**要求**：Windows 10 / 11（64 位）。

1. 从 [Releases](https://github.com/whb123456/locra/releases) 下载 `Locra-0.1.0-x64.exe`
2. 双击安装：非静默安装，可自选安装目录，默认创建桌面快捷方式

### 首次运行：未签名，会被 SmartScreen 拦下

安装包**没有代码签名**，首次运行会弹「Windows 已保护你的电脑」。

- 图形界面：点「更多信息」→「仍要运行」
- 命令行（先去掉"来自 Internet"的标记，PowerShell 里执行）：

```powershell
Unblock-File .\Locra-0.1.0-x64.exe
```

> 未签名时 SmartScreen 的「未知发布者」提示无法彻底消除，只能手动放行；要彻底解决需要
> 购买代码签名证书给 exe 签名。

### Windows 上的行为差异

- **同步用 junction 而不是符号链接**：Windows 建符号链接需要管理员权限或开发者模式，
  所以目录（Skill）走 junction，这个不需要特权；万一连 junction 都建不了（例如目标在不同盘符），
  会自动退化为**复制**。
- **退化为复制时不会跟随源目录变化**：改完 Skill 需要重新同步一次。
- CodeBuddy 的数据目录按平台自动切换为 `%APPDATA%\CodeBuddy CN\...`。

---

## 本地开发与打包

```bash
npm install
npm run dev          # vite + tsc --watch + electron 一起跑
npm run build        # 类型检查 + 前端构建
npm run package:mac  # 构建并打 dmg，产物在 release/
```

**发版流程**：版本号是安装包文件名的一部分，所以别直接改 `package.json` —— 升版本请走脚本，
它会同步 `package.json`、`package-lock.json` 和本文档里写死的产物文件名，然后提交并打 tag：

```bash
npm run bump:minor    # 或 bump:patch / bump:major
npm run release:mac   # 打包 dmg 并推送提交 + tag（Windows 用 release:win）
```

产物：`release/Locra-<version>-<arch>.dmg`

> `release/`、`dist/`、`dist-electron/` 都在 `.gitignore` 里。**安装包不进 git**，
> 通过 GitHub Releases 分发（`gh release create v0.1.0 release/Locra-0.1.0-arm64.dmg`）。

---

## 数据与目录

**应用状态**：`app.getPath('userData')/locra.json`，保存导入记录、同步目标、链接记录与分类。

旧版本数据可能仍在：

```text
~/Library/Application Support/skill-manager/skill-manager.json
```

**会话读取来源**：

| Agent | 位置 |
|---|---|
| Codex | `~/.codex/state_N.sqlite` 的 `threads` 表（与 Codex 自身列表一致；`source` 含 `subagent` 的派生线程不计入），读不到时回退扫描 `~/.codex/sessions/**/*.jsonl` |
| Claude Code | `~/.claude/projects/**` 的 `*.jsonl` |
| CodeBuddy | `~/Library/Application Support/CodeBuddy CN/codebuddy-sessions.vscdb` |

**代码目录**：

- `src/`：React 渲染进程界面
- `electron/`：主进程，负责本地文件、软链接、会话解析
- `dist/`：前端构建产物
- `dist-electron/`：主进程构建产物
- `release/`：安装包输出目录

---

## 已知限制

- **仅 arm64 且未签名/未公证**，需要按上面的方式手动放行
- **会话列表不提供进入正文**：详情抽屉的实现保留着，但当前列表项不可点击
- **长会话只读最近一段消息**（`thread_history` 目前只解析最新片段），消息数会比实际少
- **Windows 版同样未签名**，首次运行需要在 SmartScreen 里放行
- **Windows 上可能需要退化为复制**：无法建链时 Skill/Rule 是拷贝而非软链接，源目录之后的变化不会自动同步
