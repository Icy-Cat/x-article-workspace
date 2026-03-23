# X Article Workspace

Monorepo for the local X article toolchain.

## What is included

- `apps/obsidian`: Obsidian plugin host
- `apps/vscode`: VS Code extension host
- `packages/core`: shared markdown and preview logic
- `packages/i18n`: shared localization strings
- `packages/publish`: shared browser publish template and MCP flow
- `packages/shared-types`: shared settings and payload types
- `skills/x-article-upload`: Claude Code skill for uploading Markdown to X article drafts

## Goals

- Keep Obsidian and VS Code behavior aligned
- Keep browser publish logic in one shared place
- Maintain Claude skill automation in the same workspace as host code

## Common commands

```bash
pnpm -C apps/obsidian build
pnpm -C apps/vscode package
```

## Notes

- This repository is the main development workspace.
- Host-specific release packaging can still happen from each app directory.
