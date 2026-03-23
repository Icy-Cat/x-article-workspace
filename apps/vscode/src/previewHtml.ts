import * as vscode from "vscode";

export interface PreviewHtmlInput {
  title: string;
  summary: string;
  cover: string | null;
  html: string;
  showDraftNotice: boolean;
  draftNotice: string;
  empty?: boolean;
  labels: {
    heroBadge: string;
    publish: string;
    refresh: string;
    emptyTitle: string;
    emptySummary: string;
    emptyBody: string;
  };
}

export function buildPreviewHtml(webview: vscode.Webview, input: PreviewHtmlInput): string {
  const nonce = String(Date.now());
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    :root {
      color-scheme: light dark;
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-editor-foreground);
      --muted: var(--vscode-descriptionForeground);
      --card: color-mix(in srgb, var(--bg) 88%, #ffffff 12%);
      --border: color-mix(in srgb, var(--fg) 10%, transparent);
      --blue: #1d9bf0;
    }
    body { margin: 0; background: radial-gradient(circle at top, rgba(29,155,240,.12), transparent 32%), var(--bg); color: var(--fg); font-family: var(--vscode-font-family); }
    .shell { min-height: 100vh; padding: 20px 14px 32px; box-sizing: border-box; }
    .toolbar, .chrome, .card { max-width: 684px; margin: 0 auto; }
    .toolbar { position: sticky; top: 10px; z-index: 2; display: flex; gap: 10px; margin-bottom: 14px; }
    .toolbar button { border: 0; border-radius: 999px; padding: 9px 15px; cursor: pointer; color: var(--fg); background: color-mix(in srgb, var(--bg) 78%, #1d9bf0 22%); box-shadow: 0 8px 24px rgba(15,20,25,.12); }
    .toolbar .primary { color: #fff; background: var(--blue); }
    .hero, .card { overflow: hidden; border: 1px solid var(--border); border-radius: 22px; background: var(--card); }
    .cover { position: relative; height: 0; padding-bottom: 40%; background: linear-gradient(135deg, rgba(29,155,240,.35), rgba(15,20,25,.12)); background-size: cover; background-position: center; }
    .cover.has-image { background-image: linear-gradient(180deg, rgba(15,20,25,.06), rgba(15,20,25,.16)), var(--cover-image); }
    .badge { position: absolute; right: 16px; bottom: 16px; display: inline-flex; padding: 8px 12px; border-radius: 999px; background: rgba(15,20,25,.72); color: #fff; font-weight: 700; }
    .hero-body { padding: 18px 18px 20px; }
    .hero-title { font-size: 24px; font-weight: 800; line-height: 1.25; }
    .hero-summary { margin-top: 10px; color: var(--fg); white-space: pre-line; opacity: .9; line-height: 1.55; }
    .draft { padding: 18px 48px 0; color: var(--muted); font-size: 13px; line-height: 1.5; }
    .draft.hidden { display: none; }
    .body { color: var(--fg); }
    .body-inner { max-width: 684px; padding: 20px 48px 80px; box-sizing: border-box; }
    .body-inner h1 { margin: 0 0 28px; font-size: 31px; line-height: 1.3; }
    .body-inner h2,.body-inner h3 { margin: 0 0 24px; font-size: 26px; line-height: 1.35; }
    .body-inner p,.body-inner blockquote,.body-inner ul,.body-inner ol,.body-inner pre,.body-inner figure,.body-inner table,.body-inner hr { margin: 0 0 28px; }
    .body-inner p,.body-inner li,.body-inner blockquote { font-size: 17px; line-height: 28px; }
    .body-inner blockquote { padding-left: 24px; border-left: 3px solid color-mix(in srgb, var(--fg) 30%, transparent); }
    .body-inner img { display: block; max-width: 100%; height: auto; border-radius: 16px; }
    .body-inner pre { padding: 12px; border-radius: 12px; overflow: auto; background: color-mix(in srgb, var(--bg) 88%, #f7f9f9 12%); }
    .body-inner code { font-family: Consolas, "Fira Code", monospace; }
    .post-card { padding: 16px; border: 1px solid var(--border); border-radius: 20px; background: rgba(29,155,240,.05); }
    .post-header { display: flex; gap: 12px; align-items: center; margin-bottom: 12px; }
    .post-avatar { width: 40px; height: 40px; border-radius: 999px; background: linear-gradient(135deg, #1d9bf0, #7dc3f7); }
    .post-name { font-weight: 700; }
    .post-handle { color: var(--muted); font-size: 13px; }
    .post-link { color: var(--blue); text-decoration: none; font-weight: 700; }
    .empty { padding: 56px 28px 72px; text-align: center; color: var(--muted); }
    .empty-box { padding: 24px 28px; border: 1px dashed var(--border); border-radius: 18px; background: rgba(29,155,240,.04); }
    @media (max-width: 760px) {
      .shell { padding: 16px 10px 24px; }
      .draft { padding: 16px 24px 0; }
      .body-inner { padding: 20px 24px 56px; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <div class="toolbar">
      <button class="primary" data-command="publish">${escapeHtml(input.labels.publish)}</button>
      <button data-command="refresh">${escapeHtml(input.labels.refresh)}</button>
    </div>
    <div class="chrome">
      <div class="hero">
        <div class="cover ${input.cover ? "has-image" : ""}" style="${input.cover ? `--cover-image:url('${escapeAttribute(input.cover)}')` : ""}">
          <div class="badge">${escapeHtml(input.labels.heroBadge)}</div>
        </div>
        <div class="hero-body">
          <div class="hero-title">${escapeHtml(input.title || input.labels.emptyTitle)}</div>
          <div class="hero-summary">${escapeHtml(input.summary || input.labels.emptySummary)}</div>
        </div>
      </div>
    </div>
    <div class="card">
      <div class="draft ${input.showDraftNotice ? "" : "hidden"}">${escapeHtml(input.draftNotice)}</div>
      <div class="body">
        ${input.empty ? `<div class="empty"><div class="empty-box">${escapeHtml(input.labels.emptyBody)}</div></div>` : `<div class="body-inner" id="article-root">${input.html}</div>`}
      </div>
    </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.querySelectorAll("[data-command]").forEach((button) => {
      button.addEventListener("click", () => {
        vscode.postMessage({ type: button.getAttribute("data-command") });
      });
    });

    const root = document.getElementById("article-root");
    if (root) {
      root.querySelectorAll("p").forEach((paragraph) => {
        const text = (paragraph.textContent || "").trim();
        const link = paragraph.querySelector("a");
        if (link && paragraph.children.length === 1 && text === link.href && /(?:x|twitter)\\.com\\/.+\\/status\\//i.test(link.href)) {
          const match = link.href.match(/^https?:\\/\\/(?:www\\.)?(?:x\\.com|twitter\\.com)\\/([^/]+)\\/status\\/(\\d+)/i);
          const handle = match?.[1] || "unknown";
          const statusId = match?.[2] || "";
          paragraph.outerHTML = \`
            <div class="post-card">
              <div class="post-header">
                <div class="post-avatar"></div>
                <div>
                  <div class="post-name">@\${handle}</div>
                  <div class="post-handle">Post ID \${statusId}</div>
                </div>
              </div>
              <div>Open the original post on X to view the live embed content.</div>
              <div style="margin-top:14px"><a class="post-link" href="\${link.href}">View post on X</a></div>
            </div>
          \`;
        }
      });
    }
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/'/g, "&#39;");
}
