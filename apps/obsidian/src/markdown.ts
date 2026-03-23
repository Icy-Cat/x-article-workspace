import { TFile } from "obsidian";
import type { XArticlePreviewSettings } from "./settings";
import { buildPreviewMarkdown as buildSharedPreviewMarkdown } from "@x-article/core";

export function buildPreviewMarkdown(
	file: TFile,
	markdown: string,
	settings: XArticlePreviewSettings,
): string {
	return buildSharedPreviewMarkdown(file.basename, markdown, settings);
}
