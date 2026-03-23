import * as vscode from "vscode";
import { DEFAULT_SETTINGS, type XArticleSettings } from "@x-article/shared-types";

export function getSettings(): XArticleSettings {
  const config = vscode.workspace.getConfiguration("xArticle");
  return {
    locale: config.get("locale", DEFAULT_SETTINGS.locale),
    playwrightToken: config.get("playwrightToken", DEFAULT_SETTINGS.playwrightToken),
    enableDebugLog: config.get("enableDebugLog", DEFAULT_SETTINGS.enableDebugLog),
    autoRefresh: config.get("autoRefresh", DEFAULT_SETTINGS.autoRefresh),
    autoApplyCover: config.get("autoApplyCover", DEFAULT_SETTINGS.autoApplyCover),
    stripFrontmatter: config.get("stripFrontmatter", DEFAULT_SETTINGS.stripFrontmatter),
    useFilenameAsTitle: config.get("useFilenameAsTitle", DEFAULT_SETTINGS.useFilenameAsTitle),
    showDraftNotice: config.get("showDraftNotice", DEFAULT_SETTINGS.showDraftNotice),
    showWelcomeGuide: config.get("showWelcomeGuide", DEFAULT_SETTINGS.showWelcomeGuide)
  };
}
