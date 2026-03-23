# X Article Workspace

Monorepo for the local X article toolchain.

## Start here

- Main workspace repo for ongoing development
- Shared source of truth for browser publishing logic
- Unified home for Obsidian, VS Code, and Claude skill automation

## What is included

- `apps/obsidian`: Obsidian plugin host
- `apps/vscode`: VS Code extension host
- `packages/core`: shared markdown and preview logic
- `packages/i18n`: shared localization strings
- `packages/publish`: shared browser publish template and MCP flow
- `packages/shared-types`: shared settings and payload types
- `skills/x-article-upload`: Claude Code skill for uploading Markdown to X article drafts

## How to use each host

### Obsidian

- Source: `apps/obsidian`
- Build:

```bash
pnpm -C apps/obsidian build
```

### VS Code

- Source: `apps/vscode`
- Package extension:

```bash
pnpm -C apps/vscode package
```

- Install from generated `.vsix` in `apps/vscode/`

### Claude skill

- Source: `skills/x-article-upload`
- Main script:

```bash
node "skills/x-article-upload/scripts/upload-article.mjs" "<absolute-path-to-file.md>"
```

- If a local Claude skill wrapper exists, it can forward to this workspace copy.

## Goals

- Keep Obsidian and VS Code behavior aligned
- Keep browser publish logic in one shared place
- Maintain Claude skill automation in the same workspace as host code

## Common commands

```bash
pnpm -C apps/obsidian build
pnpm -C apps/vscode package
```

## Repository layout

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

## Notes

- This repository is the main development workspace.
- Host-specific release packaging can still happen from each app directory.
