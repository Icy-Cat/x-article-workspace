// API mode orchestrator. Receives an already-connected StdioMcpClient and
// the absolute path to a markdown file. Drives the full upload via direct
// GraphQL POSTs (no menu interaction).

import { parseMarkdown } from "./parse-md.mjs";
import { uploadOneImage, flushAutosave } from "./upload-images.mjs";
import { buildContentState } from "./build-content.mjs";
import { saveContent, saveTitle, getArticleState } from "./save-content.mjs";
import { makeBridge } from "./mcp-bridge.mjs";

/**
 * Run API mode end-to-end. Caller is responsible for: token resolution,
 * MCP connect, navigating to a draft URL (compose/articles/edit/<id>) and
 * letting the editor finish loading. We only need the article id from the
 * current page's URL to be in `articleId`.
 *
 * Returns { articleId, blockCount, entityCount, missingImages[] }.
 */
export async function runApiMode({ mcpClient, mdPath, articleId, log = console.log }) {
  const bridge = makeBridge(mcpClient);

  log(`📄  Parsing ${mdPath}`);
  const parsed = parseMarkdown(mdPath);
  const types = parsed.segments.reduce(
    (a, s) => ((a[s.type] = (a[s.type] || 0) + 1), a),
    {}
  );
  log(`    Title: ${parsed.title || "(none)"}`);
  log(`    Segments: ${JSON.stringify(types)}`);

  if (!articleId) {
    const u = await bridge.evalJS(
      `(()=>{const m=location.href.match(/\\/articles\\/edit\\/(\\d+)/);return JSON.stringify({url:location.href,id:m?m[1]:null})})()`
    );
    if (!u?.id) throw new Error(`Tab is not on an article edit page: ${u?.url}`);
    articleId = u.id;
  }
  log(`📝  Article ID: ${articleId}`);

  // Upload images via the editor's onFilesAdded; collect mediaIds
  const mediaMap = {};
  const missingImages = [];
  const imgSegs = parsed.segments.filter((s) => s.type === "image");
  if (imgSegs.length > 0) {
    log(`🖼️   Uploading ${imgSegs.length} image(s)...`);
    let i = 0;
    for (const seg of imgSegs) {
      i++;
      const label = seg.source.length > 60 ? "..." + seg.source.slice(-57) : seg.source;
      let lastErr = null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const info = await uploadOneImage({ bridge, source: seg.source, alt: seg.alt });
          mediaMap[seg.source] = info;
          log(`    [${i}/${imgSegs.length}] ✓ ${label}  media_id=…${info.mediaId.slice(-8)}`);
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          if (attempt < 2) await new Promise((r) => setTimeout(r, 2000));
        }
      }
      if (lastErr) {
        log(`    [${i}/${imgSegs.length}] ✗ ${label}  ${lastErr.message}`);
        missingImages.push(seg.source);
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    log(`💾  Triggering autosave to bind mediaIds (~10s)...`);
    await flushAutosave(bridge);
  }

  const { content_state } = buildContentState(parsed, mediaMap);
  log(
    `🧱  Built content: ${content_state.blocks.length} blocks, ${content_state.entity_map.length} entities`
  );

  if (parsed.title) {
    try {
      const tr = await saveTitle({ bridge, articleId, title: parsed.title });
      log(`📌  Title save: status=${tr?.status} err=${tr?.err || "OK"}`);
    } catch (e) {
      log(`⚠   Title save failed: ${e.message}`);
    }
  }

  log(`💾  Saving content...`);
  const sr = await saveContent({ bridge, articleId, contentState: content_state });
  log(`    status=${sr?.status} err=${sr?.err || "OK"} hasData=${sr?.hasData}`);

  await bridge.sleep(2000);
  log(`🔍  Verifying via ArticleEntityResultByRestId...`);
  const verify = await getArticleState({ bridge, articleId });
  log(
    `    title=${verify?.title || "(none)"} blocks=${verify?.blockCount} entities=${verify?.entityCount}`
  );

  return {
    articleId,
    blockCount: verify?.blockCount,
    entityCount: verify?.entityCount,
    missingImages,
    url: `https://x.com/compose/articles/edit/${articleId}`,
  };
}
