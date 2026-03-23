import * as vscode from "vscode";

export function openGuide(context: vscode.ExtensionContext): void {
  const panel = vscode.window.createWebviewPanel(
    "xArticleGuide",
    "X Article Quick Start",
    vscode.ViewColumn.Beside,
    { enableScripts: false }
  );

  panel.webview.html = `<!DOCTYPE html>
  <html>
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <style>
        body { font-family: var(--vscode-font-family); color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); padding: 24px; line-height: 1.65; }
        .card { max-width: 720px; margin: 0 auto; padding: 24px 28px; border: 1px solid color-mix(in srgb, var(--vscode-editor-foreground) 10%, transparent); border-radius: 20px; background: color-mix(in srgb, var(--vscode-editor-background) 90%, white 10%); }
        h1 { margin-top: 0; }
        h2 { margin-top: 24px; }
        code { font-family: Consolas, monospace; }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>X Article in VS Code</h1>
        <h2>Preview</h2>
        <p>Open a Markdown document, run <code>X Article: Open Preview</code>, and the sidebar will follow the current file.</p>
        <p>Use frontmatter <code>title</code> and <code>cover</code> to control the hero title and cover image.</p>
        <h2>Publish</h2>
        <p>Use <code>X Article: Copy Publish Script</code> to paste into the X article editor console, or <code>X Article: Publish Through Browser</code> to publish through Playwright MCP.</p>
        <p>For browser publishing you need local <code>node</code>, <code>npm</code>, <code>npx</code>, and a connected Playwright MCP Bridge extension.</p>
      </div>
    </body>
  </html>`;

  void context.globalState.update("xArticle.hasShownGuide", true);
}
