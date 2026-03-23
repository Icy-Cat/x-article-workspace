import type { XArticleSettings } from "@x-article/shared-types";

const FRONTMATTER_PATTERN = /^---\n[\s\S]*?\n---\n*/;
const LEADING_HEADING_PATTERN = /^\s*#\s+/m;

export function buildPreviewMarkdown(
	fileBasename: string,
	markdown: string,
	settings: XArticleSettings,
): string {
	let output = markdown.replace(/\r\n/g, "\n");

	if (settings.stripFrontmatter) {
		output = output.replace(FRONTMATTER_PATTERN, "");
	}

	output = output.trim();

	if (settings.useFilenameAsTitle && !LEADING_HEADING_PATTERN.test(output)) {
		output = `# ${fileBasename}\n\n${output}`;
	}

	return output;
}
