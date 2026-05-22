import * as vscode from "vscode";
import path from "node:path";
import { buildPreviewMetadata, parseFrontmatter } from "@x-article/core";
import { publishViaDetectedMcp } from "@x-article/publish";
import type { XArticleSettings } from "@x-article/shared-types";
import { INJECT_CORE_RUNNER_SHA256, INJECT_CORE_RUNNER_SOURCE } from "./vendor/injectCoreRunner";

type RunnerImageAsset =
  | { ok: true; base64: string; mime: string; fileName?: string }
  | { ok: false; error: string };

type RunnerImageMap = Record<string, RunnerImageAsset>;

type ImageReference = {
  raw: string;
  normalized: string;
};

const IMAGE_FETCH_CONCURRENCY = 4;

export async function buildInjectCorePublishFunction(
  document: vscode.TextDocument,
  settings: XArticleSettings
): Promise<{ functionSource: string; stagedImages: number; runnerSha256: string }> {
  const markdown = buildInjectCoreMarkdown(document, settings);
  const imageMap = await buildImageMap(document.uri, markdown);
  return {
    functionSource: buildInjectCoreEvaluateFunction(markdown, imageMap),
    stagedImages: Object.keys(imageMap).length,
    runnerSha256: INJECT_CORE_RUNNER_SHA256
  };
}

export async function publishActiveDocumentWithInjectCore(
  context: vscode.ExtensionContext,
  document: vscode.TextDocument,
  settings: XArticleSettings,
  appendLog: (event: string, details: Record<string, unknown>) => Promise<void>
): Promise<{ source: string }> {
  const prepared = await buildInjectCorePublishFunction(document, settings);
  await appendLog("publish.inject_core.prepare", {
    document: document.uri.fsPath,
    runnerSha256: prepared.runnerSha256,
    stagedImages: prepared.stagedImages
  });
  const result = await publishViaDetectedMcp(prepared.functionSource, {
    savedToken: settings.playwrightToken,
    logger: {
      enabled: settings.enableDebugLog,
      append: appendLog
    }
  });
  await appendLog("publish.inject_core.success", {
    document: document.uri.fsPath,
    runnerSha256: prepared.runnerSha256,
    source: result.source
  });
  return result;
}

function buildInjectCoreMarkdown(document: vscode.TextDocument, settings: XArticleSettings): string {
  const basename = path.basename(document.uri.fsPath).replace(/\.[^.]+$/, "");
  const preview = buildPreviewMetadata(basename, document.getText(), {
    ...settings,
    // Keep frontmatter for inject-core so title/cover metadata stays available.
    stripFrontmatter: false
  });
  return preview.markdown;
}

async function buildImageMap(documentUri: vscode.Uri, markdown: string): Promise<RunnerImageMap> {
  const references = collectImageReferences(markdown);
  const map: RunnerImageMap = {};
  const limit = createConcurrencyLimiter(IMAGE_FETCH_CONCURRENCY);
  await Promise.all(
    references.map((reference) =>
      limit(async () => {
        const asset = await resolveImageAsset(documentUri, reference);
        addImageMapEntry(map, reference.raw, asset);
        addImageMapEntry(map, reference.normalized, asset);
      })
    )
  );
  return map;
}

function collectImageReferences(markdown: string): ImageReference[] {
  const references: ImageReference[] = [];
  const seen = new Set<string>();
  const add = (raw: string): void => {
    const normalized = normalizeImageTarget(raw);
    if (!normalized) return;
    const key = `${raw}\n${normalized}`;
    if (seen.has(key)) return;
    seen.add(key);
    references.push({ raw, normalized });
  };

  let match: RegExpExecArray | null;
  const markdownImagePattern = /!\[([^\]]*)\]\(([^)]+)\)/g;
  while ((match = markdownImagePattern.exec(markdown)) !== null) {
    add(match[2] ?? "");
  }
  const wikiImagePattern = /!\[\[([^\]]+)\]\]/g;
  while ((match = wikiImagePattern.exec(markdown)) !== null) {
    add(match[1] ?? "");
  }
  const cover = parseFrontmatter(markdown).cover;
  if (cover) add(normalizeFrontmatterImageTarget(cover));
  return references;
}

async function resolveImageAsset(documentUri: vscode.Uri, reference: ImageReference): Promise<RunnerImageAsset> {
  if (/^https?:\/\//i.test(reference.normalized)) {
    return resolveRemoteImageAsset(reference.normalized);
  }
  const fileUri = resolveFileUri(documentUri, reference.normalized);
  try {
    const bytes = Buffer.from(await vscode.workspace.fs.readFile(fileUri));
    return {
      ok: true,
      fileName: path.basename(fileUri.fsPath),
      mime: getMimeType(fileUri.fsPath),
      base64: bytes.toString("base64")
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function resolveRemoteImageAsset(target: string): Promise<RunnerImageAsset> {
  try {
    const response = await fetch(target);
    if (!response.ok) {
      return { ok: false, error: `remote image ${response.status}: ${target}` };
    }
    const mime = response.headers.get("content-type")?.split(";")[0] || inferMimeFromPath(target);
    return {
      ok: true,
      fileName: extractRemoteFileName(target, mime),
      mime,
      base64: Buffer.from(await response.arrayBuffer()).toString("base64")
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function createConcurrencyLimiter(limit: number): <T>(run: () => Promise<T>) => Promise<T> {
  let activeCount = 0;
  const queue: Array<{
    run: () => Promise<unknown>;
    resolve: (value: unknown) => void;
    reject: (reason?: unknown) => void;
  }> = [];

  const next = (): void => {
    if (activeCount >= limit || queue.length === 0) return;
    const task = queue.shift();
    if (!task) return;
    activeCount += 1;
    void Promise.resolve()
      .then(task.run)
      .then(task.resolve, task.reject)
      .finally(() => {
        activeCount -= 1;
        next();
      });
  };

  return <T>(run: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      queue.push({
        run: run as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject
      });
      next();
    });
}

function addImageMapEntry(map: RunnerImageMap, key: string, asset: RunnerImageAsset): void {
  const trimmed = key.trim();
  if (!trimmed) return;
  map[trimmed] = asset;
  const decoded = safeDecodeUri(trimmed);
  if (decoded !== trimmed) map[decoded] = asset;
}

function normalizeImageTarget(target: string): string {
  return target
    .replace(/^!\[\[|\]\]$/g, "")
    .replace(/^!\[[^\]]*\]\((.+)\)$/u, "$1")
    .split("|")[0]
    ?.replace(/^</, "")
    .replace(/>$/, "")
    .trim() ?? "";
}

function normalizeFrontmatterImageTarget(value: string): string {
  return value
    .replace(/^!\[\[|\]\]$/g, "")
    .replace(/^!\[[^\]]*\]\(([^)]+)\)$/u, "$1")
    .trim();
}

function resolveFileUri(documentUri: vscode.Uri, target: string): vscode.Uri {
  const clean = safeDecodeUri(target).replace(/^\.?\//, "");
  return vscode.Uri.file(path.resolve(path.dirname(documentUri.fsPath), clean));
}

function getMimeType(target: string): string {
  return inferMimeFromPath(target);
}

function inferMimeFromPath(target: string): string {
  const extension = target.split("?")[0]?.split(".").pop()?.toLowerCase();
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

function extractRemoteFileName(target: string, mime: string): string {
  const cleanUrl = target.split("?")[0] ?? target;
  const lastSegment = cleanUrl.split("/").pop()?.trim();
  if (lastSegment) return lastSegment;
  return `remote-image.${mime.split("/")[1] ?? "png"}`;
}

function safeDecodeUri(value: string): string {
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}

function buildInjectCoreEvaluateFunction(markdown: string, imageMap: RunnerImageMap): string {
  const runnerSource = JSON.stringify(INJECT_CORE_RUNNER_SOURCE);
  const markdownSource = JSON.stringify(markdown);
  const imageMapSource = JSON.stringify(imageMap);
  return `async () => {
    const runnerSource = ${runnerSource};
    const markdown = ${markdownSource};
    const imageMap = ${imageMapSource};
    (0, eval)(runnerSource);
    const api = window.__xArticleInjectCore;
    if (!api || typeof api.runMarkdown !== "function") {
      throw new Error("inject-core runner did not install.");
    }
    return api.runMarkdown({ markdown, imageMap });
  }`;
}
