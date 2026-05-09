// Upload images via the editor's React `props.onFilesAdded` and read back
// the X-assigned (mediaId, entityKey, localMediaId) from EditorState.
//
// This is the only step in api-mode that needs the editor page to be
// loaded — the actual content_state save afterwards is a pure POST.
//
// All page-side JS is funneled through `bridge.evalJS()` (see mcp-bridge.mjs);
// the same module works under bb-browser too if its evalJS is plugged in.

import { readFileSync } from "node:fs";
import { extname, basename } from "node:path";

function inferMime(filename) {
  const ext = extname(filename).slice(1).toLowerCase();
  return ({
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
  })[ext] || "image/png";
}

// Stage the entire base64 in one browser_evaluate call. Both Playwright
// MCP (stdio JSON-RPC) and bb-browser daemon (HTTP) handle large payloads
// fine; the previous 5.5 KB chunking was a leftover from an earlier
// cmd.exe-spawn variant of bb-browser that hit Windows' 32 KB cmdline
// limit. Per-image staging time dropped from ~10 s to ~200 ms.
async function stageBytes(bridge, base64) {
  await bridge.evalJS(
    `(()=>{window.__imgB64=${JSON.stringify(base64)};return window.__imgB64.length})()`
  );
}

/**
 * Upload one image. `bridge` is { evalJS, press, sleep } from mcp-bridge.
 * `source` may be a local absolute path or an http(s) URL.
 * Returns { mediaId, entityKey, localMediaId, mediaCategory }.
 */
export async function uploadOneImage({ bridge, source, alt }) {
  let mime, filename;
  if (/^https?:\/\//i.test(source)) {
    const resp = await fetch(source, { redirect: "follow" });
    if (!resp.ok) throw new Error(`Remote image fetch failed: ${source} → HTTP ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    mime = (resp.headers.get("content-type") || "image/png").split(";")[0].trim();
    filename =
      basename(source.split("?")[0]).split("/").pop() || "remote." + (mime.split("/")[1] || "png");
    if (!filename.includes(".")) filename += "." + (mime.split("/")[1] || "png");
    await stageBytes(bridge, buf.toString("base64"));
  } else {
    const buf = readFileSync(source);
    mime = inferMime(source);
    filename = basename(source);
    await stageBytes(bridge, buf.toString("base64"));
  }

  // Browser-side: assemble File, snapshot existing MEDIA entity keys, call onFilesAdded
  const filenameJs = JSON.stringify(filename);
  const mimeJs = JSON.stringify(mime);
  const callJs = `(async()=>{
    try {
      const b64 = window.__imgB64 || '';
      const bin = atob(b64);
      const u = new Uint8Array(bin.length);
      for (let i=0; i<bin.length; i++) u[i] = bin.charCodeAt(i);
      const blob = new Blob([u], { type: ${mimeJs} });
      const file = new File([blob], ${filenameJs}, { type: ${mimeJs} });

      function getFiber(n){const k=Object.keys(n).find(x=>x.startsWith('__reactFiber$'));return k?n[k]:null}
      const ed = document.querySelector("[data-contents='true']")?.closest("[contenteditable='true']")
              || document.querySelector("[contenteditable='true']");
      if (!ed) return {ok:false, step:'no editor'};
      let f = getFiber(ed), depth = 0, onFilesAdded = null;
      while (f && depth < 50) {
        const props = f.memoizedProps || f.stateNode?.props;
        if (props && typeof props.onFilesAdded === 'function') { onFilesAdded = props.onFilesAdded; break; }
        f = f.return; depth++;
      }
      if (!onFilesAdded) return {ok:false, step:'no onFilesAdded'};

      function findDraft(node){let f=getFiber(node),d=0;while(f&&d<60){const sn=f.stateNode;if(sn?.props?.editorState)return sn;f=f.return;d++;}return null;}
      const editor = findDraft(ed);
      const csBefore = editor?.props?.editorState?.getCurrentContent?.();
      const before = new Set();
      csBefore?.getBlockMap()?.forEach((b)=>{
        if(b.getType()==='atomic'){
          b.findEntityRanges(c=>!!c.getEntity(),(s)=>{
            const ek=b.getCharacterList().get(s)?.getEntity?.();
            if(ek) before.add(ek);
          });
        }
      });

      onFilesAdded([file]);
      delete window.__imgB64;
      return {ok:true, beforeKeys: Array.from(before)};
    } catch (e) {
      return {ok:false, step:'exception', err: String(e?.message || e)};
    }
  })()`;
  const callRes = await bridge.evalJS(callJs);
  if (!callRes?.ok) throw new Error(`uploadOneImage call failed: ${JSON.stringify(callRes)}`);
  const beforeKeys = callRes.beforeKeys || [];

  // Poll for the new MEDIA entity (60s)
  let info = null;
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    await bridge.sleep(300);
    const probe = await bridge.evalJS(
      `(()=>{
        function getFiber(n){const k=Object.keys(n).find(x=>x.startsWith('__reactFiber$'));return k?n[k]:null}
        const ed=document.querySelector("[data-contents='true']")?.closest("[contenteditable='true']")||document.querySelector("[contenteditable='true']");
        if(!ed)return null;
        let f=getFiber(ed),d=0;
        while(f&&d<60){if(f.stateNode?.props?.editorState)break;f=f.return;d++;}
        const cs=f?.stateNode?.props?.editorState?.getCurrentContent?.();
        if(!cs)return null;
        const beforeSet=new Set(${JSON.stringify(beforeKeys)});
        const news=[];
        cs.getBlockMap().forEach((b)=>{
          if(b.getType()!=='atomic')return;
          b.findEntityRanges(c=>!!c.getEntity(),(s)=>{
            const ek=b.getCharacterList().get(s)?.getEntity?.();
            if(!ek||beforeSet.has(ek))return;
            try{
              const ent=cs.getEntity(ek);
              if(ent?.getType?.()==='MEDIA'){
                const data=ent.getData();
                const mi=data?.mediaItems?.[0]||data?.media_items?.[0];
                if(mi?.mediaId||mi?.media_id){
                  news.push({entityKey:ek,mediaId:mi.mediaId||mi.media_id,localMediaId:String(mi.localMediaId??mi.local_media_id??1),mediaCategory:mi.mediaCategory||mi.media_category||'DraftTweetImage'});
                }
              }
            }catch{}
          });
        });
        return JSON.stringify(news);
      })()`
    );
    const arr = typeof probe === "string" ? JSON.parse(probe) : probe;
    if (Array.isArray(arr) && arr.length > 0) {
      info = arr[0];
      break;
    }
  }
  if (!info) throw new Error(`uploadOneImage timed out waiting for MEDIA entity`);
  return info;
}

/**
 * Trigger X's autosave debouncer once after all images are uploaded so the
 * server binds every staged mediaId to the article. Without this, the
 * subsequent ArticleEntityUpdateContent POST will reject the mediaIds with
 * "Internal: Unspecified" and the images will render as eternal progressbars.
 */
export async function flushAutosave(bridge) {
  await bridge.evalJS(
    `(()=>{const ed=document.querySelector("[data-contents='true']")?.closest("[contenteditable='true']")||document.querySelector("[contenteditable='true']");ed?.focus();return ed?'ok':'no-ed'})()`
  );
  await bridge.press("Backspace");
  // ~5s for the autosave debouncer + ~1s round-trip
  await bridge.sleep(8000);
}
