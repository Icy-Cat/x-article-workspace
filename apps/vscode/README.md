# X Article in VS Code

Preview the current Markdown document in an X Article-style sidebar and publish it through Playwright MCP.

## Install

1. Open VS Code.
2. Open the Extensions view.
3. Select `...` in the top-right corner.
4. Choose `Install from VSIX...`.
5. Select `x-article-vscode-0.1.1.vsix`.

## How to use

1. Open a Markdown document in VS Code.
2. Run `X Article: Open Preview` from the command palette.
3. The `X Article` sidebar will follow the active Markdown file.

For publishing:

- Use `X Article: Copy Publish Script` to copy a browser script and paste it into the X Article editor console.
- Use `X Article: Publish Through Browser` to publish directly through Playwright MCP.

## Settings

Search for `xArticle` in VS Code settings.

- `xArticle.playwrightToken`: Optional `PLAYWRIGHT_MCP_EXTENSION_TOKEN` for browser publishing
- `xArticle.autoApplyCover`: Automatically click Apply after cover upload
- `xArticle.autoRefresh`: Refresh preview when the active Markdown editor changes
- `xArticle.stripFrontmatter`: Hide YAML frontmatter in preview
- `xArticle.useFilenameAsTitle`: Use the filename when the document has no H1
- `xArticle.showDraftNotice`: Show a local-only draft notice above the article body

## Browser publish requirements

To use `X Article: Publish Through Browser`, make sure you have:

- Local `node`, `npm`, and `npx`
- Playwright MCP Bridge installed in the browser
- A usable Playwright token if your local setup requires it

## Commands

- `X Article: Open Preview`
- `X Article: Refresh Preview`
- `X Article: Copy Publish Script`
- `X Article: Publish Through Browser`
- `X Article: Open Quick Start Guide`

## Features

- Follow the active Markdown editor
- Frontmatter `title` and `cover` support
- X Article-style preview in a sidebar
- Copy browser publish script
- Publish through Playwright MCP
