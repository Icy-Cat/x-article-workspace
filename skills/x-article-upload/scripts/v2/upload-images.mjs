// 用 bb-browser 在已打开的编辑器页面里：
//   1. 把图片 base64 通过分块 staging 注入 window.__imgChunks
//   2. 在浏览器侧组装成 File，调用编辑器的 props.onFilesAdded([file])
//   3. 等几秒，从 EditorState 里读出 X 生成的 (mediaId, entityKey, localMediaId)
//
// 关键：local image → readFile + base64 → 分块 → staging
//      remote URL → 浏览器自己 fetch（X CSP 允许 fetch http(s) URL）

import { readFileSync } from "node:fs";
import { extname, basename } from "node:path";
import { evalJS, press, sleep } from "./bb.mjs";

const CHUNK_SIZE = 5500; // 安全字符数（每条 eval 命令）

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

async function stageBytes(base64, tab) {
  // Reset
  await evalJS(`(()=>{window.__imgChunks=[];return 'reset'})()`, { tab });
  // Push chunks
  for (let i = 0; i < base64.length; i += CHUNK_SIZE) {
    const chunk = base64.slice(i, i + CHUNK_SIZE);
    // Use base64 chars only — safe to embed in single-quoted string
    const js = `(()=>{window.__imgChunks.push('${chunk}');return window.__imgChunks.length})()`;
    await evalJS(js, { tab });
  }
}

/**
 * Upload a single image via the editor's onFilesAdded prop.
 * Returns { mediaId, entityKey, localMediaId } from the resulting MEDIA entity.
 *
 * Caller: page must be on an article edit URL with the editor loaded.
 */
export async function uploadOneImage({ source, alt, tab }) {
  // 1. 拿 bytes（统一走 Node 端，远程也用 Node fetch 避开 X CSP）
  let mime, filename;
  if (/^https?:\/\//i.test(source)) {
    const resp = await fetch(source, { redirect: "follow" });
    if (!resp.ok) throw new Error(`Remote image fetch failed: ${source} → HTTP ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    mime = (resp.headers.get("content-type") || "image/png").split(";")[0].trim();
    filename =
      basename(source.split("?")[0]).split("/").pop() || "remote." + (mime.split("/")[1] || "png");
    if (!filename.includes(".")) filename += "." + (mime.split("/")[1] || "png");
    await stageBytes(buf.toString("base64"), tab);
  } else {
    const buf = readFileSync(source);
    mime = inferMime(source);
    filename = basename(source);
    await stageBytes(buf.toString("base64"), tab);
  }

  // 2. 浏览器侧组装 File，调 onFilesAdded
  const filenameJs = JSON.stringify(filename);
  const altJs = JSON.stringify(alt || "");
  const mimeJs = JSON.stringify(mime);
  const callJs = `(async()=>{
    try {
      // Concat chunks → base64 → Uint8Array → Blob → File
      const b64 = (window.__imgChunks||[]).join('');
      const bin = atob(b64);
      const u = new Uint8Array(bin.length);
      for (let i=0; i<bin.length; i++) u[i] = bin.charCodeAt(i);
      const blob = new Blob([u], { type: ${mimeJs} });
      const file = new File([blob], ${filenameJs}, { type: ${mimeJs} });

      // 找最浅 props.onFilesAdded
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

      // Snapshot existing media entities so we can spot the new one
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
      // free the staged data
      delete window.__imgChunks;

      return {ok:true, beforeCount: before.size, beforeKeys: Array.from(before)};
    } catch (e) {
      return {ok:false, step:'exception', err: String(e?.message || e)};
    }
  })()`;
  const callRes = await evalJS(callJs, { tab, timeoutMs: 30000 });
  if (!callRes?.ok) throw new Error(`uploadOneImage call failed: ${JSON.stringify(callRes)}`);
  const beforeKeys = callRes.beforeKeys || [];

  // 3. 等上传完成（轮询新 MEDIA entity 出现，60s 容错）
  let info = null;
  const deadlineMs = Date.now() + 60000;
  while (Date.now() < deadlineMs) {
    await sleep(800);
    const probe = await evalJS(
      `(()=>{
        function getFiber(n){const k=Object.keys(n).find(x=>x.startsWith('__reactFiber$'));return k?n[k]:null}
        const ed=document.querySelector("[data-contents='true']")?.closest("[contenteditable='true']")||document.querySelector("[contenteditable='true']");
        if(!ed)return null;
        let f=getFiber(ed),d=0;
        while(f&&d<60){if(f.stateNode?.props?.editorState)break;f=f.return;d++;}
        const editor=f?.stateNode;
        const cs=editor?.props?.editorState?.getCurrentContent?.();
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
      })()`,
      { tab }
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
 * After all images are uploaded, call this once to trigger X's autosave to bind
 * all mediaIds to the article on the server. Waits long enough for the autosave
 * debouncer (~5s) to fire and the network round-trip to complete.
 */
export async function flushAutosave(tab) {
  await evalJS(
    `(()=>{const ed=document.querySelector("[data-contents='true']")?.closest("[contenteditable='true']")||document.querySelector("[contenteditable='true']");ed?.focus();return ed?'ok':'no-ed'})()`,
    { tab }
  );
  await press("Backspace", { tab });
  // X's autosave debouncer fires ~5s after last input + ~1s for round-trip
  await sleep(8000);
}

