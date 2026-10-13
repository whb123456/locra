# Locra 项目说明

## 简介

Locra 是一个基于 Electron、React 和 Vite 构建的本地 Skill 管理桌面应用。它用于导入本地 Skill 目录，并通过符号链接同步到 Claude Code、Codex、Cursor、CodeBuddy 或自定义目标目录。

## 主要能力

- 导入包含 `SKILL.md` 的本地 Skill；
- 浏览 Skill 描述和文件；
- 为 Skill 设置分类并进行筛选；
- 管理预置及自定义同步目标；
- 将 Skill 以软链接形式添加到目标目录或移除；
- 自动基于当前用户的 Home 目录生成预置工具的默认目录。

## 技术栈

- Electron
- React
- TypeScript
- Vite
- electron-builder

## 常用命令

```bash
npm run dev
npm run build
npm run package:mac
```

## 数据存储

应用状态由 Electron 的 `app.getPath('userData')` 目录管理，并以 `locra.json` 保存导入记录、同步目标、链接记录和分类。

旧版本数据仍可能位于：

```text
~/Library/Application Support/skill-manager/skill-manager.json
```

## 目录说明

- `src/`：React 渲染进程界面；
- `electron/`：Electron 主进程与本地文件、软链接操作；
- `dist/`：前端构建产物；
- `dist-electron/`：Electron 主进程构建产物；
- `release/`：macOS 安装包输出目录。
