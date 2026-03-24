# X Article Workspace

[English](./README_EN.md)

X Article 的主开发仓库。

这里统一维护 X 长文预览、Markdown 渲染、浏览器发布流程，以及不同宿主环境的接入层，避免 Obsidian、VS Code 和 Claude skill 各自维护一套实现。

## 仓库定位

- 这是日常开发使用的 monorepo
- 共享逻辑集中在 `packages/`
- 宿主层放在 `apps/`
- Claude / Codex 使用的自动化上传能力放在 `skills/`

如果你只是想安装或查看 Obsidian 插件的发布说明，可以去 `G:\Projects\0Tools\x-article-in-obsidian`；那个仓库保留的是 Obsidian 视角的发布与分发文档。

## 当前包含内容

### `apps/`

- `apps/obsidian`: Obsidian 插件宿主
- `apps/vscode`: VS Code 扩展宿主

### `packages/`

- `packages/core`: Markdown 渲染、预览和文章转换相关的共享逻辑
- `packages/i18n`: 中英文文案与本地化资源
- `packages/publish`: 浏览器发布脚本、Playwright MCP 相关流程
- `packages/shared-types`: 宿主与共享层共用的类型定义

### `skills/`

- `skills/x-article-upload`: 面向 Claude Code / Codex 的本地上传技能

## 适合做什么

- 同步维护 Obsidian 和 VS Code 两个宿主的预览体验
- 让浏览器发布逻辑只保留一份共享实现
- 在同一个仓库里维护本地自动化上传脚本和宿主集成
- 作为后续发布、调试和功能迭代的唯一主工作区

## 使用说明

这个仓库主要有三种使用方式：

### 1. 直接使用 VS Code 扩展

如果你只是想开始使用，优先从 Release 获取安装包，而不是自己构建：

- VS Code 用户：优先下载 `apps/vscode` 对应产物或仓库发布页中的 `.vsix`
- Obsidian 用户：优先查看 `G:\Projects\0Tools\x-article-in-obsidian` 中面向最终用户的安装说明和 Release

如果你需要自己打包 VS Code 扩展，可以执行：

```bash
pnpm -C apps/vscode package
```

命令完成后，会在 `apps/vscode` 目录下生成 `.vsix` 文件，可在 VS Code 中手动安装。

### 2. 使用 Obsidian 插件

如果你主要在 Obsidian 里写作和预览，可使用：

```text
apps/obsidian
```

这个 workspace 包含 Obsidian 宿主代码；如果你更关心面向最终用户的安装、发布和截图说明，优先查看 `G:\Projects\0Tools\x-article-in-obsidian`。

### 3. 直接调用本地上传脚本

如果你想把 Markdown 文件直接走本地自动化上传流程，可以执行：

```bash
node "skills/x-article-upload/scripts/upload-article.mjs" "<absolute-path-to-file.md>"
```

适合接入 Claude Code、Codex，或者你自己的本地包装脚本。

## 快速开始

如果你是开发者，再从这里开始：

### 安装依赖

```bash
pnpm install
```

### 根目录常用命令

```bash
pnpm build
pnpm build:vscode
pnpm lint
```

当前根脚本默认聚焦 VS Code 宿主构建：

- `pnpm build`: 构建 VS Code 扩展
- `pnpm build:vscode`: 同上
- `pnpm lint`: 执行 VS Code 宿主类型检查

## 按宿主开发

### Obsidian

源码目录：

```text
apps/obsidian
```

常用命令：

```bash
pnpm -C apps/obsidian build
pnpm -C apps/obsidian lint
```

### VS Code

源码目录：

```text
apps/vscode
```

常用命令：

```bash
pnpm -C apps/vscode build
pnpm -C apps/vscode lint
pnpm -C apps/vscode package
```

`package` 会在 `apps/vscode` 下生成可安装的 `.vsix` 包。

### Claude / Codex 上传技能

主入口脚本位于：

```text
skills/x-article-upload/scripts/upload-article.mjs
```

可直接执行：

```bash
node "skills/x-article-upload/scripts/upload-article.mjs" "<absolute-path-to-file.md>"
```

如果你的本地 Claude Code skill 只是一个包装层，也可以直接转发到这里的脚本。

## 目录结构

```text
x-article-workspace/
├── apps/
│   ├── obsidian/
│   └── vscode/
├── packages/
│   ├── core/
│   ├── i18n/
│   ├── publish/
│   └── shared-types/
└── skills/
    └── x-article-upload/
```

## 设计目标

- 不同宿主看到尽量一致的 X Article 预览效果
- 浏览器发布流程只在一处维护
- 本地自动化脚本和宿主代码共用同一套共享模块
- 后续新增宿主或自动化入口时，尽量复用现有 `packages/`

## 开发说明

- 根目录使用 `pnpm workspace`
- 当前 `package.json` 暴露的是最常用的 VS Code 开发命令
- 宿主差异化构建命令仍然保留在各自子目录
- 发布、宿主包装和文档可以按各自场景拆分，但共享逻辑应优先回收到这个 workspace

## 相关仓库

- `G:\Projects\0Tools\x-article-in-obsidian`: Obsidian 插件发布仓库与用户向文档入口
