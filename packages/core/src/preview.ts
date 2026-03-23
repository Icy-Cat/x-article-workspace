import type { PreviewMetadata, XArticleSettings } from "@x-article/shared-types";
import { buildPreviewMarkdown } from "./markdown";
import { parseFrontmatter } from "./frontmatter";

const X_POST_URL_PATTERN =
  /^https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/[^/]+\/status\/\d+(?:[/?#].*)?$/i;

export function buildPreviewMetadata(
  fileBasename: string,
  rawMarkdown: string,
  settings: XArticleSettings
): PreviewMetadata {
  const frontmatter = parseFrontmatter(rawMarkdown);
  const markdown = buildPreviewMarkdown(fileBasename, rawMarkdown, settings);
  const title = frontmatter.title || extractFirstHeading(markdown) || fileBasename;
  const summary = extractSummary(markdown) || "Previewing the current note with the X article layout.";
  return {
    title,
    summary,
    cover: frontmatter.cover,
    frontmatter,
    markdown
  };
}

function extractFirstHeading(markdown: string): string | null {
  const match = markdown.match(/^\s*#\s+(.+)$/m);
  return match?.[1]?.trim() || null;
}

function stripMarkdownSyntax(value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "$1")
    .replace(/!\[\[([^\]]+)\]\]/g, " ")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    .replace(/^>\s?/gm, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[-*+]\s+/gm, "")
    .replace(/^\d+\.\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/\r/g, "");
}

function extractSummary(markdown: string): string {
  const lines = stripMarkdownSyntax(markdown)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !X_POST_URL_PATTERN.test(line));

  const parts: string[] = [];
  for (const line of lines) {
    parts.push(line);
    const candidate = parts.join("\n\n");
    if (candidate.length >= 260) {
      return candidate.slice(0, 260).trim();
    }
  }
  return parts.join("\n\n").trim();
}
