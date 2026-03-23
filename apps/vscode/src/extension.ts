import * as vscode from "vscode";
import { translate } from "@x-article/i18n";
import { buildBrowserPublishFunction, buildBrowserPublishScript, publishViaDetectedMcp } from "@x-article/publish";
import { buildPreviewHtml } from "./previewHtml";
import { buildPublishPayload, buildRenderedPreview } from "./payload";
import { openGuide } from "./guide";
import { PublishLogger } from "./logger";
import { getSettings } from "./settings";

const VIEW_ID = "xArticle.preview";

class XArticlePreviewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | null = null;

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void | Thenable<void> {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        this.context.extensionUri,
        ...(vscode.workspace.workspaceFolders?.map((folder) => folder.uri) ?? [])
      ]
    };

    webviewView.webview.onDidReceiveMessage(async (message) => {
      if (message?.type === "refresh") {
        await this.refresh();
      } else if (message?.type === "publish") {
        await publishActiveDocument(this.context);
      }
    });

    void this.refresh();
  }

  async refresh(): Promise<void> {
    if (!this.view) {
      return;
    }

    const settings = getSettings();
    const editor = vscode.window.activeTextEditor;
    const document = editor?.document;
    const locale = settings.locale;

    if (!document || document.languageId !== "markdown") {
      this.view.webview.html = buildPreviewHtml(this.view.webview, {
        title: translate(locale, "view.empty.title"),
        summary: translate(locale, "view.empty.summary"),
        cover: null,
        html: "",
        showDraftNotice: false,
        draftNotice: translate(locale, "view.draftNotice"),
        empty: true,
        labels: {
          heroBadge: translate(locale, "view.heroBadge"),
          publish: translate(locale, "view.publish"),
          refresh: translate(locale, "view.refresh"),
          emptyTitle: translate(locale, "view.empty.title"),
          emptySummary: translate(locale, "view.empty.summary"),
          emptyBody: translate(locale, "view.empty.body")
        }
      });
      return;
    }

    const preview = await buildRenderedPreview(document, this.view.webview, settings);
    this.view.webview.html = buildPreviewHtml(this.view.webview, {
      title: preview.title,
      summary: preview.summary,
      cover: preview.cover,
      html: preview.html,
      showDraftNotice: settings.showDraftNotice,
      draftNotice: translate(locale, "view.draftNotice"),
      labels: {
        heroBadge: translate(locale, "view.heroBadge"),
        publish: translate(locale, "view.publish"),
        refresh: translate(locale, "view.refresh"),
        emptyTitle: translate(locale, "view.empty.title"),
        emptySummary: translate(locale, "view.empty.summary"),
        emptyBody: translate(locale, "view.empty.body")
      }
    });
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new XArticlePreviewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider),
    vscode.commands.registerCommand("xArticle.openPreview", async () => {
      await vscode.commands.executeCommand("workbench.view.extension.xArticle");
      await provider.refresh();
    }),
    vscode.commands.registerCommand("xArticle.refreshPreview", async () => {
      await provider.refresh();
    }),
    vscode.commands.registerCommand("xArticle.copyPublishScript", async () => {
      await copyPublishScript();
    }),
    vscode.commands.registerCommand("xArticle.publishViaMcp", async () => {
      await publishActiveDocument(context);
    }),
    vscode.commands.registerCommand("xArticle.openGuide", () => {
      openGuide(context);
    }),
    vscode.window.onDidChangeActiveTextEditor(async () => {
      if (getSettings().autoRefresh) {
        await provider.refresh();
      }
    }),
    vscode.workspace.onDidChangeTextDocument(async (event) => {
      if (!getSettings().autoRefresh) {
        return;
      }
      if (vscode.window.activeTextEditor?.document.uri.toString() === event.document.uri.toString()) {
        await provider.refresh();
      }
    }),
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (event.affectsConfiguration("xArticle")) {
        await provider.refresh();
      }
    })
  );

  if (getSettings().showWelcomeGuide && !context.globalState.get("xArticle.hasShownGuide")) {
    openGuide(context);
  }
}

export function deactivate(): void {}

async function copyPublishScript(): Promise<void> {
  const document = getActiveMarkdownDocument();
  if (!document) {
    void vscode.window.showErrorMessage("Open a Markdown note first.");
    return;
  }
  const payload = await buildPublishPayload(document, getSettings());
  await vscode.env.clipboard.writeText(buildBrowserPublishScript(payload));
  void vscode.window.showInformationMessage("Copied the X publish script to the clipboard.");
}

async function publishActiveDocument(context: vscode.ExtensionContext): Promise<void> {
  const document = getActiveMarkdownDocument();
  if (!document) {
    void vscode.window.showErrorMessage("Open a Markdown note first.");
    return;
  }

  try {
    const settings = getSettings();
    const payload = await buildPublishPayload(document, settings);
    const logger = new PublishLogger(context, settings.enableDebugLog);
    const result = await publishViaDetectedMcp(buildBrowserPublishFunction(payload), {
      savedToken: settings.playwrightToken,
      logger: {
        enabled: settings.enableDebugLog,
        append: (event, details) => logger.append(event, details)
      }
    });
    void vscode.window.showInformationMessage(`Published to X through Playwright MCP (${result.source}).`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Publishing through MCP failed.";
    void vscode.window.showErrorMessage(message);
  }
}

function getActiveMarkdownDocument(): vscode.TextDocument | null {
  const document = vscode.window.activeTextEditor?.document;
  if (!document || document.languageId !== "markdown") {
    return null;
  }
  return document;
}
