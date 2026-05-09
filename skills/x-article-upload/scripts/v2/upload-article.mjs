#!/usr/bin/env node
/**
 * upload-article.mjs (v2) — pure-API X article uploader
 *
 * 流程：
 *   1. 解析 .md → segments
 *   2. 找/打开一个 X article 编辑器标签页（必须，用来跑 onFilesAdded 上传图）
 *   3. 对每张图 onFilesAdded 上传 + Backspace autosave → 拿 mediaId/entityKey
 *   4. 拼 RawDraftContentState → POST ArticleEntityUpdateContent
 *   5. POST ArticleEntityUpdateTitle
 *   6. 验证 ArticleEntityResultByRestId
 *
 * 用法：
 *   node upload-article.mjs <file.md> [--tab <tab-id>] [--draft <draft-id>]
 *
 * 如果不传 --tab，自动找当前已打开的 article 编辑器标签页。
 * 如果不传 --draft，假设 --tab 指向的标签页就是目标草稿。
 */

import { argv, exit } from "node:process";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

import { parseMarkdown } from "./parse-md.mjs";
import { uploadOneImage, flushAutosave } from "./upload-images.mjs";
import { buildContentState } from "./build-content.mjs";
import { saveContent, saveTitle, getArticleState } from "./save-content.mjs";
import { evalJS, findArticleTab, sleep } from "./bb.mjs";

// ── CLI args
const args = argv.slice(2);
const filePath = args.find((a) => !a.startsWith("-"));
if (!filePath) {
  console.error("Usage: node upload-article.mjs <file.md> [--tab <tab-id>] [--draft <draft-id>]");
  exit(1);
}
const absPath = resolve(filePath);
if (!existsSync(absPath)) {
  console.error(`File not found: ${absPath}`);
  exit(1);
}
const tabIdx = args.indexOf("--tab");
let tabArg = tabIdx >= 0 ? args[tabIdx + 1] : null;
const draftIdx = args.indexOf("--draft");
let draftIdArg = draftIdx >= 0 ? args[draftIdx + 1] : null;

async function main() {
  // 1. parse
  console.log(`📄  Parsing ${absPath}`);
  const parsed = parseMarkdown(absPath);
  const imgCount = parsed.segments.filter((s) => s.type === "image").length;
  const types = parsed.segments.reduce((acc, s) => {
    acc[s.type] = (acc[s.type] || 0) + 1;
    return acc;
  }, {});
  console.log(`    Title: ${parsed.title || "(none)"}`);
  console.log(`    Segments: ${JSON.stringify(types)}`);

  // 2. find tab
  if (!tabArg) {
    tabArg = await findArticleTab();
    if (!tabArg) {
      console.error(
        "❌  No X article editor tab found. Open an empty draft first (https://x.com/compose/articles)."
      );
      exit(1);
    }
  }
  console.log(`🔌  Using tab: ${tabArg}`);

  // Verify editor is loaded + extract article id from URL
  let articleId = draftIdArg;
  if (!articleId) {
    const urlInfo = await evalJS(
      `(()=>{const m=location.href.match(/\\/articles\\/edit\\/(\\d+)/);return JSON.stringify({url:location.href,id:m?m[1]:null})})()`,
      { tab: tabArg }
    );
    if (!urlInfo.id) {
      console.error(`❌  Tab is not on an article edit page: ${urlInfo.url}`);
      exit(1);
    }
    articleId = urlInfo.id;
  }
  console.log(`📝  Article ID: ${articleId}`);

  // 3. upload images
  const mediaMap = {};
  if (imgCount > 0) {
    console.log(`🖼️   Uploading ${imgCount} image(s) via editor.props.onFilesAdded...`);
    let i = 0;
    for (const seg of parsed.segments) {
      if (seg.type !== "image") continue;
      i++;
      const label = seg.source.length > 60 ? "..." + seg.source.slice(-57) : seg.source;
      process.stdout.write(`    [${i}/${imgCount}] ${label} ... `);
      let lastErr = null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const info = await uploadOneImage({ source: seg.source, alt: seg.alt, tab: tabArg });
          mediaMap[seg.source] = info;
          console.log(`✓ media_id=${info.mediaId.slice(-8)}…`);
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          if (attempt < 2) {
            process.stdout.write(`(retry) `);
            await new Promise((r) => setTimeout(r, 2000));
          }
        }
      }
      if (lastErr) console.log(`✗ ${lastErr.message}`);
      // 让图片之间留点缓冲，避免 onFilesAdded 触发的 React re-render 互相干扰
      await new Promise((r) => setTimeout(r, 1500));
    }
    console.log(`💾  Triggering autosave to bind mediaIds (~10s)...`);
    await flushAutosave(tabArg);
  }

  // 4. build content_state
  const { content_state } = buildContentState(parsed, mediaMap);
  console.log(
    `🧱  Built content: ${content_state.blocks.length} blocks, ${content_state.entity_map.length} entities`
  );

  // 5. POST title (best-effort, ignore failures)
  if (parsed.title) {
    try {
      const tr = await saveTitle({ articleId, title: parsed.title, tab: tabArg });
      console.log(`📌  Title saved: ${tr?.status || "?"}`);
    } catch (e) {
      console.warn(`⚠   Title save failed: ${e.message}`);
    }
  }

  // 6. POST content
  console.log(`💾  Saving content (POST ArticleEntityUpdateContent)...`);
  const sr = await saveContent({ articleId, contentState: content_state, tab: tabArg });
  console.log(`    status=${sr?.status} err=${sr?.err || "OK"} hasData=${sr?.hasData}`);

  // 7. verify
  await sleep(2000);
  console.log(`🔍  Verifying via ArticleEntityResultByRestId...`);
  const verify = await getArticleState({ articleId, tab: tabArg });
  console.log(`    title=${verify?.title || "(none)"} blocks=${verify?.blockCount} entities=${verify?.entityCount}`);

  console.log(`\n✅  Done. Open: https://x.com/compose/articles/edit/${articleId}`);
}

main().catch((e) => {
  console.error("❌ ", e.message);
  console.error(e.stack);
  exit(1);
});
