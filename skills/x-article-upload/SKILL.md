---
name: x-article-upload
description: Upload a local Markdown (.md) file to X (Twitter/X.com) as an article draft. Use this skill whenever the user wants to publish, upload, post, or sync a markdown file to X article, X long-form post, Twitter article editor, or X.com/compose/articles. Triggers on phrases like "upload md to X", "post my markdown to X article", "save article draft to X", "把markdown上传到X文章", "发布文章到X", "上传草稿到推特", even if the user doesn't say "skill" explicitly.
---

# X Article Upload Skill

This directory is the maintained source for the Claude Code upload skill.

If a local Claude skill directory is used as a compatibility wrapper, keep implementation changes in this workspace copy and let the wrapper forward execution here.

Upload a local Markdown file to X (Twitter) article draft editor in one shot:
detect token → spawn playwright MCP via npx → navigate → inject content — no manual steps.

The preferred path is the inject-core runner, which reuses the same Markdown
import pipeline as x-article-md-paste:

```bash
node "<SKILL_DIR>/scripts/upload-article-inject-core.mjs" "<absolute-path-to-file.md>"
```

The older `scripts/upload-article.mjs` remains available for compatibility.

## Usage

```bash
node "<SKILL_DIR>/scripts/upload-article-inject-core.mjs" "<absolute-path-to-file.md>"
```

Replace `<SKILL_DIR>` with the actual path to this skill's directory.

That's it. The script handles everything:
- Token detection and MCP startup
- Markdown → HTML conversion
- Browser navigation to `x.com/compose/articles`
- Clicking Create, waiting for editor
- Injecting title, body, code blocks, dividers

---

## Token Setup (first-time only)

The script auto-detects the Playwright MCP Bridge token from:
1. `<skill-dir>/.env` file (fastest, checked first)
2. `PLAYWRIGHT_MCP_EXTENSION_TOKEN` environment variable
3. MCP config files (`~/.cursor/mcp.json`, `~/.claude.json`, Codex, Gemini, etc.)
4. Browser profile LevelDB scan (Chrome / Edge)

**If detection fails**, the script prints a clear error:
```
❌  Playwright MCP Bridge token not found.

To fix this, provide the token one of these ways:
  1. Pass it directly:  node upload-article.mjs file.md --token <TOKEN>
  2. Save it to .env:   echo "PLAYWRIGHT_MCP_EXTENSION_TOKEN=<TOKEN>" > <skill-dir>/.env
  3. Set env var:       set PLAYWRIGHT_MCP_EXTENSION_TOKEN=<TOKEN>

You can find the token in the Playwright MCP Bridge extension popup in Chrome/Edge.
```

Ask the user to provide the token, then save it:
```bash
node "<SKILL_DIR>/scripts/upload-article.mjs" "<file.md>" --token <TOKEN>
```

On first successful run with `--token`, offer to persist it:
```bash
node "<SKILL_DIR>/scripts/detect-playwright-token.mjs" --save <TOKEN>
```

This writes to `<skill-dir>/.env` so future runs don't need `--token`.

---

## Prerequisites

- **Node.js v16+** — for running the script
- **Playwright MCP Bridge** Chrome/Edge extension — for browser control
- **Active X session** — user must be logged in to x.com in the browser

Check Node.js:
```bash
node --version
```

---

## What the script does internally

1. **Token resolution** — checks `.env` → env var → config files → browser scan
2. **Markdown processing** — strips frontmatter, extracts title, converts to HTML,
   replaces code blocks / HR dividers with `MPH_MARKER_N` placeholders
3. **Spawn MCP** — runs `npx -y @playwright/mcp@latest --extension` with token in env,
   connects via stdio JSON-RPC (initialize handshake)
4. **Navigate** — `browser_navigate` → `x.com/compose/articles`, wait 2s
5. **Open editor** — `browser_evaluate` clicks the Create button, waits for contenteditable
6. **Inject** — single `browser_evaluate` call runs the full injection function:
   - Sets title field
   - Pastes HTML via ClipboardEvent (fallback: `execCommand`)
   - For each `MPH_MARKER_N`: opens Insert menu → Code/Divider dialogs, fills content
   - Cleans up residual marker text
7. **Done** — prints success + URL, closes MCP process

---

## Edge Cases

**User not logged in to X:**
The navigation will redirect to the login page. The script will time out waiting
for the editor. Tell the user to log in to x.com first, then retry.

**Markdown has local images:**
Local image paths are included as `<img src="...">` tags. X will not load them.
Tell the user to either host images remotely first, or insert them manually after upload.

**npx not in PATH on Windows:**
If the script fails with `spawn npx ENOENT`, Node.js / npx is not on PATH.
Ask the user to reinstall Node.js from https://nodejs.org and reopen their terminal.

---

## File Map

```
x-article-upload/
├── SKILL.md                         ← You are here
├── .env                             ← Token cache (auto-created, gitignored)
└── scripts/
    ├── upload-article-inject-core.mjs ← Main inject-core end-to-end script (use this)
    ├── upload-article.mjs           ← Legacy menu/api upload script
    ├── detect-playwright-token.mjs  ← Token detection only (for debugging)
    └── process-md.mjs               ← Markdown processing only (for debugging)
```
