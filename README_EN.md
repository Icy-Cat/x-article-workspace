# X Article Workspace

[中文](./README.md)

Primary development workspace for X Article.

This monorepo keeps the X Article preview pipeline, Markdown rendering, browser publishing flow, and host-specific integrations in one place so Obsidian, VS Code, and local automation do not drift apart.

## Repository Role

- Main monorepo for day-to-day development
- Shared logic lives in `packages/`
- Host integrations live in `apps/`
- Claude / Codex upload automation lives in `skills/`

If you only want the Obsidian plugin release-facing docs, use `G:\Projects\0Tools\x-article-in-obsidian`. That repository keeps the Obsidian-specific release and distribution view.

## What's Included

### `apps/`

- `apps/obsidian`: Obsidian plugin host
- `apps/vscode`: VS Code extension host

### `packages/`

- `packages/core`: shared Markdown rendering, preview, and article conversion logic
- `packages/i18n`: shared localization resources
- `packages/publish`: browser publishing scripts and Playwright MCP flow
- `packages/shared-types`: shared types used across hosts and packages

### `skills/`

- `skills/x-article-upload`: local upload skill for Claude Code / Codex

## What This Workspace Is For

- Keeping Obsidian and VS Code preview behavior aligned
- Maintaining browser publishing logic in a single shared package
- Developing local upload automation next to host integrations
- Using one workspace as the main source of truth for ongoing feature work

## Quick Start

### Install dependencies

```bash
pnpm install
```

### Common root commands

```bash
pnpm build
pnpm build:vscode
pnpm lint
```

The root scripts currently focus on the VS Code host:

- `pnpm build`: build the VS Code extension
- `pnpm build:vscode`: same as above
- `pnpm lint`: run VS Code host type checks

## Host-Specific Development

### Obsidian

Source directory:

```text
apps/obsidian
```

Common commands:

```bash
pnpm -C apps/obsidian build
pnpm -C apps/obsidian lint
```

### VS Code

Source directory:

```text
apps/vscode
```

Common commands:

```bash
pnpm -C apps/vscode build
pnpm -C apps/vscode lint
pnpm -C apps/vscode package
```

`package` generates an installable `.vsix` file under `apps/vscode`.

### Claude / Codex Upload Skill

Main entry script:

```text
skills/x-article-upload/scripts/upload-article.mjs
```

Direct usage:

```bash
node "skills/x-article-upload/scripts/upload-article.mjs" "<absolute-path-to-file.md>"
```

If you already have a local Claude Code wrapper skill, it can forward to this workspace script.

## Repository Layout

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

## Design Goals

- Keep the X Article reading experience consistent across hosts
- Maintain browser publishing flow in one place
- Reuse the same shared packages across UI hosts and automation
- Make this workspace the primary source of truth for future iteration

## Development Notes

- The repo uses a `pnpm` workspace
- The root `package.json` exposes the most common VS Code-oriented commands
- Host-specific build and packaging commands still live in each app directory
- Shared logic should be consolidated here first, even if release packaging stays in host-specific repos

## Related Repository

- `G:\Projects\0Tools\x-article-in-obsidian`: release-facing repository and end-user docs for the Obsidian plugin
