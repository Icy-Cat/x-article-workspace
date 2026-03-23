import * as vscode from "vscode";
import path from "node:path";
import MarkdownIt from "markdown-it";
import { load } from "cheerio";
import { buildPreviewMetadata, parseFrontmatter } from "@x-article/core";
import type { PublishImageAsset, PublishItem, PublishPayload, XArticleSettings } from "@x-article/shared-types";

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false
});

export interface RenderedPreview {
  html: string;
  markdown: string;
  title: string;
  summary: string;
  cover: string | null;
}

export async function buildRenderedPreview(
  document: vscode.TextDocument,
  webview: vscode.Webview,
  settings: XArticleSettings
): Promise<RenderedPreview> {
  const preview = buildPreviewMetadata(getFileBasename(document), document.getText(), settings);
  const html = await renderMarkdownToHtml(document.uri, preview.markdown, webview);
  const cover = await resolveCoverForPreview(document.uri, preview.cover, webview);
  return {
    html,
    markdown: preview.markdown,
    title: preview.title,
    summary: preview.summary,
    cover
  };
}

export async function buildPublishPayload(
  document: vscode.TextDocument,
  settings: XArticleSettings
): Promise<PublishPayload> {
  const preview = buildPreviewMetadata(getFileBasename(document), document.getText(), settings);
  const extraction = await extractPublishItems(document.uri, preview.markdown);
  const html = await renderMarkdownToHtml(document.uri, extraction.processedMarkdown);
  const frontmatter = parseFrontmatter(document.getText());
  const cover = await resolveImageAsset(document.uri, frontmatter.cover);
  return {
    html,
    markdown: extraction.processedMarkdown,
    items: extraction.items,
    title: frontmatter.title,
    cover,
    autoApplyCover: settings.autoApplyCover
  };
}

async function extractPublishItems(
  documentUri: vscode.Uri,
  markdown: string
): Promise<{ processedMarkdown: string; items: PublishItem[] }> {
  const segments: Array<{
    type: "code" | "image" | "divider" | "post";
    start: number;
    end: number;
    language?: string;
    code?: string;
    alt?: string;
    target?: string;
    url?: string;
  }> = [];

  const codePattern = /```([^\n`]*)\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = codePattern.exec(markdown)) !== null) {
    segments.push({
      type: "code",
      start: match.index,
      end: match.index + match[0].length,
      language: (match[1] ?? "").trim(),
      code: (match[2] ?? "").replace(/\n$/, "")
    });
  }

  const dividerPattern = /^(?: {0,3})(?:(?:-{3,})|(?:\*{3,})|(?:_{3,}))(?:[ \t]*)$/gm;
  while ((match = dividerPattern.exec(markdown)) !== null) {
    const start = match.index;
    if (segments.some((segment) => start >= segment.start && start < segment.end)) {
      continue;
    }
    segments.push({
      type: "divider",
      start,
      end: start + match[0].length
    });
  }

  const postUrlPattern =
    /^(?: {0,3})(https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/[A-Za-z0-9_]+\/status\/\d+(?:\?[^\s]+)?)\s*$/gm;
  while ((match = postUrlPattern.exec(markdown)) !== null) {
    const start = match.index;
    if (segments.some((segment) => start >= segment.start && start < segment.end)) {
      continue;
    }
    segments.push({
      type: "post",
      start,
      end: start + match[0].length,
      url: (match[1] ?? "").trim()
    });
  }

  const postMarkdownLinkPattern =
    /\[(https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/[A-Za-z0-9_]+\/status\/\d+(?:\?[^\]\s]+)?)\]\((https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/[A-Za-z0-9_]+\/status\/\d+(?:\?[^)\s]+)?)\)/g;
  while ((match = postMarkdownLinkPattern.exec(markdown)) !== null) {
    const start = match.index;
    if (segments.some((segment) => start >= segment.start && start < segment.end)) {
      continue;
    }
    segments.push({
      type: "post",
      start,
      end: start + match[0].length,
      url: (match[2] ?? match[1] ?? "").trim()
    });
  }

  const imagePatterns: Array<{ kind: "markdown" | "wikilink"; pattern: RegExp }> = [
    { kind: "markdown", pattern: /!\[([^\]]*)\]\(([^)]+)\)/g },
    { kind: "wikilink", pattern: /!\[\[([^\]]+)\]\]/g }
  ];

  for (const imagePattern of imagePatterns) {
    while ((match = imagePattern.pattern.exec(markdown)) !== null) {
      const start = match.index;
      if (segments.some((segment) => start >= segment.start && start < segment.end)) {
        continue;
      }
      if (imagePattern.kind === "markdown") {
        segments.push({
          type: "image",
          start,
          end: start + match[0].length,
          alt: (match[1] ?? "").trim(),
          target: (match[2] ?? "").trim()
        });
      } else {
        segments.push({
          type: "image",
          start,
          end: start + match[0].length,
          alt: "",
          target: (match[1] ?? "").trim()
        });
      }
    }
  }

  segments.sort((left, right) => left.start - right.start);

  let processedMarkdown = markdown;
  const items: PublishItem[] = [];

  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index];
    if (!segment) {
      continue;
    }
    const marker = `MPH_MARKER_${index + 1}`;
    processedMarkdown =
      processedMarkdown.slice(0, segment.start) +
      `\n${marker}\n` +
      processedMarkdown.slice(segment.end);

    if (segment.type === "code") {
      items.unshift({
        type: "code",
        marker,
        language: segment.language ?? "",
        code: segment.code ?? ""
      });
      continue;
    }

    if (segment.type === "divider") {
      items.unshift({ type: "divider", marker });
      continue;
    }

    if (segment.type === "post") {
      items.unshift({
        type: "post",
        marker,
        url: segment.url ?? ""
      });
      continue;
    }

    const imageAsset = await resolveImageAsset(documentUri, segment.target ?? "", segment.alt ?? "");
    if (imageAsset) {
      items.unshift({ type: "image", marker, ...imageAsset });
    }
  }

  return { processedMarkdown, items };
}

async function renderMarkdownToHtml(
  documentUri: vscode.Uri,
  markdown: string,
  webview?: vscode.Webview
): Promise<string> {
  const normalized = normalizeWikiSyntax(markdown);
  const html = md.render(normalized);
  const $ = load(html);

  const imageTasks = $("img")
    .toArray()
    .map(async (element) => {
      const src = $(element).attr("src");
      if (!src) {
        return;
      }
      const resolved = await resolveImageTarget(documentUri, src, webview);
      if (resolved) {
        $(element).attr("src", resolved);
      }
    });

  await Promise.all(imageTasks);
  return $.root().html() ?? "";
}

function normalizeWikiSyntax(markdown: string): string {
  return markdown.replace(/!\[\[([^\]]+)\]\]/g, (_match, target: string) => {
    const cleanTarget = target.split("|")[0]?.trim() ?? "";
    return `![](${cleanTarget})`;
  });
}

async function resolveCoverForPreview(
  documentUri: vscode.Uri,
  rawCover: string | null,
  webview: vscode.Webview
): Promise<string | null> {
  if (!rawCover) {
    return null;
  }
  return resolveImageTarget(documentUri, normalizeImageTarget(rawCover), webview);
}

async function resolveImageTarget(
  documentUri: vscode.Uri,
  rawTarget: string,
  webview?: vscode.Webview
): Promise<string | null> {
  const target = normalizeImageTarget(rawTarget);
  if (!target) {
    return null;
  }
  if (/^https?:\/\//i.test(target)) {
    return target;
  }
  const fileUri = resolveFileUri(documentUri, target);
  try {
    await vscode.workspace.fs.stat(fileUri);
    return webview ? webview.asWebviewUri(fileUri).toString() : fileUri.toString();
  } catch {
    return null;
  }
}

async function resolveImageAsset(
  documentUri: vscode.Uri,
  rawTarget: string | null,
  alt = ""
): Promise<PublishImageAsset | null> {
  if (!rawTarget) {
    return null;
  }

  const target = normalizeImageTarget(rawTarget);
  if (!target) {
    return null;
  }

  if (/^https?:\/\//i.test(target)) {
    const response = await fetch(target);
    if (!response.ok) {
      return null;
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    return {
      alt,
      fileName: extractRemoteFileName(target, response.headers.get("content-type")),
      mimeType: response.headers.get("content-type")?.split(";")[0] || "image/png",
      base64: buffer.toString("base64")
    };
  }

  const fileUri = resolveFileUri(documentUri, target);
  const bytes = Buffer.from(await vscode.workspace.fs.readFile(fileUri));
  return {
    alt,
    fileName: pathBasename(target),
    mimeType: getMimeType(target),
    base64: bytes.toString("base64")
  };
}

function resolveFileUri(documentUri: vscode.Uri, target: string): vscode.Uri {
  const clean = target.replace(/^\.?\//, "");
  return vscode.Uri.file(path.resolve(path.dirname(documentUri.fsPath), clean));
}

function normalizeImageTarget(target: string): string {
  return target
    .replace(/^!\[\[|\]\]$/g, "")
    .replace(/^!\[[^\]]*\]\((.+)\)$/u, "$1")
    .split("|")[0]
    ?.trim() ?? "";
}

function extractRemoteFileName(target: string, contentType: string | null): string {
  const cleanUrl = target.split("?")[0] ?? target;
  const lastSegment = cleanUrl.split("/").pop()?.trim();
  if (lastSegment) {
    return lastSegment;
  }
  const extension = contentType?.split("/")[1] || "png";
  return `remote-image.${extension}`;
}

function getMimeType(target: string): string {
  const extension = target.split(".").pop()?.toLowerCase();
  switch (extension) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "svg":
      return "image/svg+xml";
    default:
      return "image/png";
  }
}

function pathBasename(target: string): string {
  return target.replace(/\\/g, "/").split("/").pop() || "image.png";
}

function getFileBasename(document: vscode.TextDocument): string {
  const parts = document.uri.path.split("/");
  const fileName = parts[parts.length - 1] || "Untitled.md";
  return fileName.replace(/\.[^.]+$/, "");
}
