// Runs in the page's MAIN world (manifest content_scripts[*].world = "MAIN").
// Has full access to React internals so Fiber walking and Immutable.js
// blockMap mutations work the same way they do from a console / bb-browser
// eval. Communicates with the bridge (isolated world) via window.postMessage.
//
// Wire-protocol:
//   bridge → main:  { source: 'xmp', kind: 'ready?' }
//                   { source: 'xmp', kind: 'run', payload: {html, plain, plan, sessionId} }
//   main   → bridge:{ source: 'xmp-main', kind: 'ready' }
//                   { source: 'xmp-main', kind: 'progress', text, level }
//                   { source: 'xmp-main', kind: 'done', summary }
//                   { source: 'xmp-main', kind: 'error', error }
//
// `plan` is an ordered list of { marker, op } where op describes how to
// transform the marker block:
//   { type: 'atomic', entityType: 'DIVIDER'|'MARKDOWN'|'TWEET', data, mutability }
//   { type: 'image', file: { base64, mime, fileName, alt } }

(function () {
  const TAG = '[XMP-MAIN]';
  const SOURCE_OUT = typeof __X_ARTICLE_SOURCE_IN__ !== 'undefined' ? __X_ARTICLE_SOURCE_IN__ : 'xmp-main';
  const SOURCE_IN = typeof __X_ARTICLE_SOURCE_OUT__ !== 'undefined' ? __X_ARTICLE_SOURCE_OUT__ : 'xmp';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const post = (kind, extra = {}) => {
    window.postMessage({ source: SOURCE_OUT, kind, ...extra }, '*');
  };
  // Progress messages cross worlds. We send an i18n key + vars; the
  // orchestrator (isolated world) holds the translation table and feeds
  // the banner. The legacy `text` field is still accepted on the
  // receiving side as a fallback for any caller that still passes raw.
  const progress = (key, vars = null, level = 'work') =>
    post('progress', { textKey: key, vars: vars || undefined, level });

  const EDITOR_SELECTOR =
    "[data-contents='true'] [contenteditable='true'], [contenteditable='true'][role='textbox'], [contenteditable='true'].public-DraftEditor-content, [contenteditable='true']";

  function findEditor() {
    for (const el of document.querySelectorAll(EDITOR_SELECTOR)) {
      const r = el.getBoundingClientRect();
      if (r.width > 200 && r.height > 100) return el;
    }
    return null;
  }

  function getDraftStateNode() {
    const editor = findEditor();
    if (!editor) return null;
    const fk = Object.keys(editor).find(
      (k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'),
    );
    if (!fk) return null;
    let f = editor[fk];
    for (let i = 0; i < 60 && f; i++) {
      const sn = f.stateNode;
      if (sn?.props?.editorState && typeof sn.props.onChange === 'function') return sn;
      f = f.return;
    }
    return null;
  }

  function getOnFilesAdded() {
    const editor = findEditor();
    if (!editor) return null;
    const fk = Object.keys(editor).find(
      (k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'),
    );
    if (!fk) return null;
    let f = editor[fk];
    for (let i = 0; i < 50 && f; i++) {
      const p = f.memoizedProps || f.stateNode?.props;
      if (p && typeof p.onFilesAdded === 'function') return p.onFilesAdded;
      f = f.return;
    }
    return null;
  }

  function pasteHtml(html, plain) {
    const editor = findEditor();
    if (!editor) return false;
    if (typeof editor.focus === 'function') editor.focus();
    const dt = new DataTransfer();
    dt.setData('text/html', html);
    dt.setData('text/plain', plain || html.replace(/<[^>]*>/g, ''));
    const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
    if (ev.clipboardData !== dt) Object.defineProperty(ev, 'clipboardData', { value: dt });
    editor.dispatchEvent(ev);
    return true;
  }

  function findMarkerBlock(sn, marker) {
    const cs = sn.props.editorState.getCurrentContent();
    let key = null;
    cs.getBlockMap().forEach((b, k) => {
      if (b.getType() === 'atomic') return;
      if ((b.getText() || '').trim() === marker) {
        key = k;
        return false;
      }
    });
    return key;
  }

  function getFirstCharacterMetadata(block) {
    const list = block?.getCharacterList?.();
    return list?.get?.(0) || list?.first?.() || list?.toArray?.()?.[0] || null;
  }

  // Apply ONE marker→atomic replacement to a contentState, returning the
  // new contentState. Doesn't call onChange — caller batches.
  function applyAtomicToCS(cs, marker, entityType, entityData, mutability, sampleCharSrc, listCtor) {
    const blockMap = cs.getBlockMap();
    let targetKey = null;
    blockMap.forEach((b, k) => {
      if (b.getType() === 'atomic') return;
      if ((b.getText() || '').trim() === marker) {
        targetKey = k;
        return false;
      }
    });
    if (!targetKey) return { ok: false, err: 'marker not found: ' + marker, cs };

    const target = blockMap.get(targetKey);
    const sampleAtomic = blockMap.find((b) => b.getType() === 'atomic') || sampleCharSrc;
    const charSample = getFirstCharacterMetadata(sampleAtomic || target);
    if (!charSample?.set) return { ok: false, err: 'no charSample', cs };

    const cs1 = cs.createEntity(entityType, mutability, entityData);
    const ek = cs1.getLastCreatedEntityKey();
    const newChar = charSample.set('entity', ek);
    const newCharList = listCtor([newChar]);
    const baseBlock = sampleAtomic || target;
    const newBlock = baseBlock.merge({
      key: targetKey,
      type: 'atomic',
      text: ' ',
      characterList: newCharList,
      depth: 0,
    });
    const newBlockMap = cs1.getBlockMap().set(targetKey, newBlock);
    const newContent = cs1.set('blockMap', newBlockMap);
    return { ok: true, ek, cs: newContent };
  }

  // Batch: replace ALL marker→atomic substitutions in ONE onChange call.
  // Reduces autosave-induced churn vs one-onChange-per-marker.
  function batchReplaceAtomics(sn, atomicSteps) {
    const es = sn.props.editorState;
    const ESCtor = es.constructor;
    const SSCtor = es.getSelection().constructor;
    let cs = es.getCurrentContent();
    const initialBlockMap = cs.getBlockMap();
    const sampleAtomic = initialBlockMap.find((b) => b.getType() === 'atomic');
    // Need a character-list constructor — sample from any block with chars
    const sampleCharBlock = sampleAtomic || initialBlockMap.find((b) => getFirstCharacterMetadata(b));
    if (!sampleCharBlock) {
      return { okCount: 0, failCount: atomicSteps.length, errs: ['no sample character block'] };
    }
    const listCtor = sampleCharBlock.getCharacterList().constructor;

    let okCount = 0;
    const failures = [];
    for (const step of atomicSteps) {
      const r = applyAtomicToCS(
        cs,
        step.marker,
        step.op.entityType,
        step.op.data || {},
        step.op.mutability || 'IMMUTABLE',
        sampleCharBlock,
        listCtor,
      );
      if (r.ok) {
        cs = r.cs;
        okCount += 1;
      } else {
        failures.push({ marker: step.marker, err: r.err });
      }
    }

    if (okCount === 0) return { okCount, failCount: failures.length, errs: failures };

    const lastKey = cs.getBlockMap().last().getKey();
    const safeSel = SSCtor.createEmpty(lastKey);
    const newContent = cs.set('selectionBefore', safeSel).set('selectionAfter', safeSel);
    let ns = ESCtor.push(es, newContent, 'insert-fragment');
    ns = ESCtor.moveSelectionToEnd(ns);
    sn.props.onChange(ns);

    return { okCount, failCount: failures.length, errs: failures };
  }

  // ── X autosave network hook ─────────────────────────────────────────
  // Monkey-patch fetch + XMLHttpRequest at script load time. Whenever X
  // POSTs to its ArticleEntityUpdateContent GraphQL mutation and the
  // response comes back 2xx, we fire all registered listeners.
  // waitForArticleSave() registers a one-shot listener that resolves on
  // the next successful save, with a configurable timeout.
  const SAVE_RE = /Article(Entity)?Update.*Content/i;
  const saveListeners = new Set();

  const _fetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : input?.url || '';
    const p = _fetch.apply(this, arguments);
    if (SAVE_RE.test(url)) {
      p.then((res) => {
        if (res && res.ok) {
          saveListeners.forEach((cb) => {
            try { cb({ url, status: res.status }); } catch {}
          });
        }
      }).catch(() => {});
    }
    return p;
  };

  const _xhrOpen = XMLHttpRequest.prototype.open;
  const _xhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__xmpUrl = url;
    return _xhrOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    if (this.__xmpUrl && SAVE_RE.test(this.__xmpUrl)) {
      this.addEventListener('load', () => {
        if (this.status >= 200 && this.status < 300) {
          saveListeners.forEach((cb) => {
            try { cb({ url: this.__xmpUrl, status: this.status }); } catch {}
          });
        }
      });
    }
    return _xhrSend.apply(this, arguments);
  };

  function waitForArticleSave(timeoutMs = 8000) {
    return new Promise((resolve) => {
      let done = false;
      const cb = (info) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        saveListeners.delete(cb);
        resolve({ ok: true, ...info });
      };
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        saveListeners.delete(cb);
        resolve({ ok: false, reason: 'timeout' });
      }, timeoutMs);
      saveListeners.add(cb);
    });
  }
  // ────────────────────────────────────────────────────────────────────

  // Compute a cheap fingerprint of the current contentState so we can tell
  // whether anything has changed between two reads.
  function contentHash(sn) {
    const cs = sn.props.editorState.getCurrentContent();
    const parts = [];
    cs.getBlockMap().forEach((b) => {
      parts.push(`${b.getKey()}:${b.getType()}:${b.getLength()}`);
    });
    return parts.join('|');
  }

  // Look for X's autosave indicator. Matches strings like 'Saving...',
  // 'Last saved X seconds ago', '刚刚最后保存', '正在保存', etc.
  function findSaveIndicator() {
    const re = /(saving|saved|保存|sync)/i;
    // Scope to the right column (composer area) to avoid noise
    const root = document.querySelector("[data-testid='composer']")?.closest('section, main, [role="main"]')
      || document.body;
    for (const el of root.querySelectorAll('span, div')) {
      const t = (el.textContent || '').trim();
      if (!t || t.length > 40) continue;
      if (re.test(t)) return { el, text: t };
    }
    return null;
  }

  // Block until: (a) the editor's blockMap is unchanged for 'stableMs' AND
  // (b) X is not currently showing 'Saving...'. Bails after timeoutMs
  // regardless. Returns reason for exit.
  async function waitForAutosaveSettle(sn, { timeoutMs = 5000, stableMs = 500 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastHash = contentHash(sn);
    let stableSince = Date.now();

    while (Date.now() < deadline) {
      await sleep(150);
      const h = contentHash(sn);
      if (h !== lastHash) {
        lastHash = h;
        stableSince = Date.now();
        continue;
      }
      const heldFor = Date.now() - stableSince;
      if (heldFor < stableMs) continue;

      // Content is stable; double-check no 'Saving...' indicator visible
      const sav = findSaveIndicator();
      if (sav && /saving|正在保存|loading/i.test(sav.text)) continue;

      return { ok: true, heldFor, indicator: sav?.text };
    }
    return { ok: false, reason: 'timeout' };
  }

  function snapshotMediaKeys(cs) {
    const seen = new Set();
    cs.getBlockMap().forEach((b) => {
      if (b.getType() !== 'atomic') return;
      b.findEntityRanges(
        (c) => !!c.getEntity(),
        (start) => {
          const k = b.getCharacterList().get(start)?.getEntity?.();
          if (!k) return;
          try {
            if (cs.getEntity(k).getType() === 'MEDIA') seen.add(k);
          } catch {
            /* ignore */
          }
        },
      );
    });
    return seen;
  }

  function base64ToFile(base64, fileName, mime) {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], fileName, { type: mime });
  }

  // Position cursor right before the marker block so onFilesAdded inserts
  // its MEDIA atomic right there (most X versions). If it lands somewhere
  // else, we relocate manually after.
  function focusMarker(sn, marker) {
    const es = sn.props.editorState;
    const SSCtor = es.getSelection().constructor;
    const ESCtor = es.constructor;
    const cs = es.getCurrentContent();
    let targetKey = null;
    cs.getBlockMap().forEach((b, k) => {
      if (b.getType() === 'atomic') return;
      if ((b.getText() || '').trim() === marker) {
        targetKey = k;
        return false;
      }
    });
    if (!targetKey) return false;
    const sel = SSCtor.createEmpty(targetKey).merge({ anchorOffset: 0, focusOffset: 0 });
    const ns = ESCtor.forceSelection(es, sel);
    sn.props.onChange(ns);
    return true;
  }

  async function insertImageAtMarker(sn, marker, file, opts = {}) {
    const onFilesAdded = getOnFilesAdded();
    if (!onFilesAdded) return { ok: false, err: 'onFilesAdded prop not reachable' };

    focusMarker(sn, marker);
    await sleep(60);

    const csBefore = sn.props.editorState.getCurrentContent();
    const before = snapshotMediaKeys(csBefore);

    onFilesAdded([file]);

    const deadline = Date.now() + (opts.timeoutMs || 60000);
    let newKey = null;
    let newMediaId = null;
    let lastHeartbeat = Date.now();
    while (Date.now() < deadline && !newKey) {
      await sleep(400);
      // Heartbeat every ~5s so the bridge's inactivity timer (60s)
      // doesn't fire during a slow upload. Without this, a 75s wait
      // for mediaId looks like silence to the bridge → bail-out.
      if (Date.now() - lastHeartbeat > 5000) {
        const elapsed = Math.round((Date.now() - (deadline - (opts.timeoutMs || 60000))) / 1000);
        progress('main_upload_progress', { elapsed });
        lastHeartbeat = Date.now();
      }
      const cs = sn.props.editorState.getCurrentContent();
      cs.getBlockMap().forEach((b) => {
        if (b.getType() !== 'atomic') return;
        b.findEntityRanges(
          (c) => !!c.getEntity(),
          (start) => {
            const k = b.getCharacterList().get(start)?.getEntity?.();
            if (!k || before.has(k)) return;
            try {
              const ent = cs.getEntity(k);
              if (ent.getType() === 'MEDIA') {
                const data = ent.getData();
                const mi = data?.mediaItems?.[0] || data?.media_items?.[0];
                const mid = mi?.mediaId || mi?.media_id;
                if (mid) { newKey = k; newMediaId = mid; }
              }
            } catch {
              /* ignore */
            }
          },
        );
      });
    }

    if (!newKey) return { ok: false, err: 'mediaId timeout' };

    // Note: relocate is NOT done here. We let all atomics pile up at the
    // end of the doc, then do a single batch reorder after every image
    // is uploaded. See batchRelocateImages() and the runFlow image loop.
    // Per-image relocate caused a race where the NEXT image's
    // onFilesAdded reverted the PREVIOUS relocate (HAR 测试151231.har:
    // IMG_1 ended up orphaned at end of doc after this regression).
    return { ok: true, ek: newKey, mediaId: newMediaId };
  }

  // Batch-relocate every uploaded image atomic from its current location
  // (typically all piled up at end-of-doc) to its corresponding marker
  // block. Single onChange — no inter-image race possible.
  //
  // `uploads` is [{ marker, ek }] in plan order. `preAtomicKeys` is the
  // set of block keys that were atomic BEFORE the image upload phase
  // started (e.g. the TWEET block from PHASE 1 atomics). Anything atomic
  // and NOT in that set is one of OUR newly uploaded MEDIA atomics.
  //
  // Matching strategy (HAR 测试1632.har lesson):
  //   1. Fast path: match upload.ek to the current atomic that still has
  //      that exact entity key.
  //   2. Fallback: when X reassigned eks during slow uploads / timeouts
  //      / X's own internal reordering, the stored ek won't match. Pair
  //      any remaining uploads (in plan order) with any remaining
  //      unclaimed "new" atomics (in document order). This relies on
  //      upload order matching document order of new atomics — which
  //      holds because X processes onFilesAdded sequentially.
  function batchRelocateImages(sn, uploads, preAtomicKeys = new Set()) {
    if (!uploads || uploads.length === 0) return { moved: 0, missing: 0 };

    const es = sn.props.editorState;
    const ESCtor = es.constructor;
    const SSCtor = es.getSelection().constructor;
    const cs = es.getCurrentContent();
    const blockMap = cs.getBlockMap();

    // Build markerKey → originKey map by scanning the blockMap once.
    const markerToOrigin = new Map();   // markerKey  → originKey
    const markerToEntry  = new Map();   // marker str → { markerKey }
    for (const u of uploads) markerToEntry.set(u.marker, { marker: u.marker });

    const ekToOriginKey = new Map();
    const newAtomics = []; // doc-order list of NEW MEDIA atomic keys
    blockMap.forEach((b, k) => {
      if (b.getType() === 'atomic') {
        let ek = null;
        b.findEntityRanges(
          (c) => !!c.getEntity(),
          (start) => {
            const candidate = b.getCharacterList().get(start)?.getEntity?.();
            if (candidate) {
              ekToOriginKey.set(candidate, k);
              if (!ek) ek = candidate;
            }
          },
        );
        // Only treat as a "new" atomic if (a) not pre-existing, (b)
        // entity is MEDIA. Pre-existing TWEET etc. must not be claimed.
        if (!preAtomicKeys.has(k) && ek) {
          try {
            const ent = cs.getEntity(ek);
            if (ent?.getType?.() === 'MEDIA') newAtomics.push({ key: k, ek });
          } catch { /* entity lookup fail — skip */ }
        }
      } else {
        const txt = (b.getText() || '').trim();
        const entry = markerToEntry.get(txt);
        if (entry) entry.markerKey = k;
      }
    });

    // Pass 1: claim atomics whose ek still matches the upload record.
    const claimedAtomicIdx = new Set();
    const remainingUploads = [];
    for (let i = 0; i < uploads.length; i++) {
      const u = uploads[i];
      const entry = markerToEntry.get(u.marker);
      if (!entry?.markerKey) continue; // marker missing → nothing we can do here
      if (!u.ek) { remainingUploads.push({ u, entry }); continue; }
      const originKey = ekToOriginKey.get(u.ek);
      if (!originKey) { remainingUploads.push({ u, entry }); continue; }
      // Confirm originKey is one of the "new" atomics and not already claimed
      const idx = newAtomics.findIndex((a) => a.key === originKey);
      if (idx < 0 || claimedAtomicIdx.has(idx)) {
        remainingUploads.push({ u, entry });
        continue;
      }
      claimedAtomicIdx.add(idx);
      if (entry.markerKey !== originKey) markerToOrigin.set(entry.markerKey, originKey);
    }

    // Pass 2: pair leftover uploads (plan-order) with leftover new
    // atomics (doc-order). This is the fix for the ek-reassignment case.
    let cursor = 0;
    let missing = 0;
    for (const { u, entry } of remainingUploads) {
      while (cursor < newAtomics.length && claimedAtomicIdx.has(cursor)) cursor++;
      if (cursor >= newAtomics.length) { missing += 1; continue; }
      const atomic = newAtomics[cursor];
      claimedAtomicIdx.add(cursor);
      cursor++;
      if (entry.markerKey !== atomic.key) markerToOrigin.set(entry.markerKey, atomic.key);
    }

    if (markerToOrigin.size === 0) return { moved: 0, missing };

    // Build new key order: walk every block; when we hit a marker, emit
    // its origin instead (and skip origins encountered standalone, since
    // they're already placed via the marker). Origins not referenced by
    // any marker (e.g. orphaned uploads) are dropped.
    const originSet = new Set(markerToOrigin.values());
    const newOrder = [];
    blockMap.forEach((_b, k) => {
      if (markerToOrigin.has(k)) {
        newOrder.push(markerToOrigin.get(k));
      } else if (originSet.has(k)) {
        // skip — will be inserted at marker position
      } else {
        newOrder.push(k);
      }
    });

    const OrderedMap = blockMap.constructor;
    let nbm = OrderedMap();
    for (const k of newOrder) nbm = nbm.set(k, blockMap.get(k));

    // Park selection on the first relocated atomic's key so Draft has a
    // valid anchor inside the new blockMap.
    const firstOrigin = newOrder.find((k) => originSet.has(k));
    const safeSel = SSCtor.createEmpty(firstOrigin || newOrder[newOrder.length - 1]);
    const newContent = cs
      .set('blockMap', nbm)
      .set('selectionBefore', safeSel)
      .set('selectionAfter', safeSel);
    let ns = ESCtor.push(es, newContent, 'remove-range');
    ns = ESCtor.moveSelectionToEnd(ns);
    sn.props.onChange(ns);
    return { moved: markerToOrigin.size, missing };
  }

  // Verify a batch relocate stuck. Two failure modes we care about:
  //   1. Any marker text reappeared in the doc.
  //   2. All uploaded atomics are clustered at the tail (≥ N-1 of them
  //      sitting consecutively at the last atomic positions), meaning X
  //      reverted our reorder.
  function verifyRelocate(sn, uploaded, markerPrefix) {
    const cs = sn.props.editorState.getCurrentContent();
    const blockMap = cs.getBlockMap();
    const ekSet = new Set(uploaded.map((u) => u.ek));
    const atomicIdxOfEk = new Map();
    const blockKeys = blockMap.keySeq().toArray();
    let markerSeen = false;
    blockKeys.forEach((k, idx) => {
      const b = blockMap.get(k);
      if (b.getType() === 'atomic') {
        b.findEntityRanges(
          (c) => !!c.getEntity(),
          (start) => {
            const ek = b.getCharacterList().get(start)?.getEntity?.();
            if (ek && ekSet.has(ek)) atomicIdxOfEk.set(ek, idx);
          },
        );
      } else {
        const t = (b.getText() || '').trim();
        if (t.startsWith(markerPrefix)) markerSeen = true;
      }
    });
    if (markerSeen) return { ok: false, reason: 'marker resurrected' };
    // Count atomics that landed in the trailing 10 blocks. If all of them
    // are crammed there, that's the regression signature.
    const totalBlocks = blockKeys.length;
    const tailThreshold = totalBlocks - Math.max(uploaded.length + 1, 10);
    let inTail = 0;
    for (const idx of atomicIdxOfEk.values()) if (idx >= tailThreshold) inTail += 1;
    if (atomicIdxOfEk.size > 0 && inTail === atomicIdxOfEk.size) {
      return { ok: false, reason: 'all atomics at tail', inTail, total: atomicIdxOfEk.size };
    }
    return { ok: true, placed: atomicIdxOfEk.size };
  }

  // Convert a single marker block into readable text. Used when an image
  // upload fails (after retry) — we keep the original `![alt](url)` ref
  // in-place so the user can manually fix / replace it later instead of
  // silently losing the reference.
  function replaceMarkerWithText(sn, marker, text) {
    const es = sn.props.editorState;
    const ESCtor = es.constructor;
    const SSCtor = es.getSelection().constructor;
    const cs = es.getCurrentContent();
    const blockMap = cs.getBlockMap();
    let targetKey = null;
    blockMap.forEach((b, k) => {
      if (b.getType() === 'atomic') return;
      if ((b.getText() || '').trim() === marker) {
        targetKey = k;
        return false;
      }
    });
    if (!targetKey) return false;
    const block = blockMap.get(targetKey);
    const CharCtor = block.getCharacterList().get(0)?.constructor;
    const emptyChar = CharCtor ? CharCtor.create({}) : null;
    const charList = block.getCharacterList().clear();
    const newCharList = emptyChar
      ? charList.toArray().concat(new Array(text.length).fill(emptyChar))
      : new Array(text.length).fill(undefined);
    const replaced = block.merge({ text, characterList: newCharList });
    const nbm = blockMap.set(targetKey, replaced);
    const sel = SSCtor.createEmpty(targetKey);
    const newContent = cs
      .set('blockMap', nbm)
      .set('selectionBefore', sel)
      .set('selectionAfter', sel);
    let ns = ESCtor.push(es, newContent, 'change-block-data');
    sn.props.onChange(ns);
    return true;
  }

  function removeLeftoverMarkers(sn, prefix) {
    const es = sn.props.editorState;
    const ESCtor = es.constructor;
    const SSCtor = es.getSelection().constructor;
    const cs = es.getCurrentContent();
    const blockMap = cs.getBlockMap();
    const removeKeys = [];
    blockMap.forEach((b, k) => {
      if (b.getType() === 'atomic') return;
      const t = (b.getText() || '').trim();
      if (t.startsWith(prefix)) removeKeys.push(k);
    });
    if (!removeKeys.length) return 0;
    let nbm = blockMap;
    for (const k of removeKeys) nbm = nbm.delete(k);
    const lastKey = nbm.last() ? nbm.last().getKey() : null;
    const safeSel = lastKey
      ? SSCtor.createEmpty(lastKey)
      : es.getSelection();
    const newContent = cs
      .set('blockMap', nbm)
      .set('selectionBefore', safeSel)
      .set('selectionAfter', safeSel);
    let ns = ESCtor.push(es, newContent, 'remove-range');
    // Force selection move so Draft.js re-renders the deleted ranges.
    // Without this, the marker text often stays visually in the DOM
    // even though the underlying blockMap no longer contains it.
    ns = ESCtor.moveSelectionToEnd(ns);
    sn.props.onChange(ns);
    return removeKeys.length;
  }

  // After all blockMap mutations, gently nudge Draft to repaint by
  // moving the selection to end-of-doc. Selection-change is enough to
  // trigger Draft's render cycle without going down the dangerous path
  // of dispatching synthetic 'input' events (HAR 测试1509.har showed
  // dispatchEvent(input) caused Draft to re-read the DOM, producing a
  // 1379-char "fallback giant block" containing the entire article
  // text + caption placeholders concatenated). Blur/refocus removed
  // for the same reason — too aggressive, side-effects unclear.
  function kickEditorRender(sn) {
    try {
      const es = sn.props.editorState;
      const ESCtor = es.constructor;
      sn.props.onChange(ESCtor.moveSelectionToEnd(es));
    } catch (e) {
      console.warn(TAG, 'kickEditorRender failed:', e);
    }
  }

  // ─────────────────────────── GraphQL helpers ───────────────────────────
  // Article title & cover are set via the same GraphQL endpoints X's own
  // autosave uses. Captured from HAR 测试1636.har:
  //   POST /i/api/graphql/x75E2ABzm8_mGTg1bz8hcA/ArticleEntityUpdateTitle
  //   POST /i/api/graphql/Es8InPh7mEkK9PxclxFAVQ/ArticleEntityUpdateCoverMedia
  // The 6 booleans in `features` are required and were copied verbatim.
  // Auth: page's session cookies (credentials: 'include') + ct0 csrf.
  const ARTICLE_FEATURES = {
    profile_label_improvements_pcf_label_in_post_enabled: true,
    responsive_web_profile_redirect_enabled: false,
    rweb_tipjar_consumption_enabled: false,
    verified_phone_label_enabled: false,
    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
    responsive_web_graphql_timeline_navigation_enabled: true,
  };
  const X_BEARER =
    'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

  function getArticleIdFromUrl() {
    return location.href.match(/\/articles\/edit\/(\d+)/)?.[1] || null;
  }
  function getCsrfToken() {
    return document.cookie.match(/(?:^|;\s*)ct0=([^;]+)/)?.[1] || '';
  }

  async function gqlPost(queryId, opName, body) {
    const r = await fetch(`https://x.com/i/api/graphql/${queryId}/${opName}`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${X_BEARER}`,
        'x-csrf-token': getCsrfToken(),
        'x-twitter-active-user': 'yes',
        'x-twitter-auth-type': 'OAuth2Session',
      },
      body: JSON.stringify(body),
    });
    let text = '';
    try { text = await r.text(); } catch { /* ignore */ }
    return { status: r.status, ok: r.ok, body: text.slice(0, 240) };
  }

  async function setArticleTitle(articleEntityId, title) {
    return gqlPost('x75E2ABzm8_mGTg1bz8hcA', 'ArticleEntityUpdateTitle', {
      variables: { articleEntityId, title: String(title) },
      features: ARTICLE_FEATURES,
      queryId: 'x75E2ABzm8_mGTg1bz8hcA',
    });
  }

  // UI title setter (preferred over GraphQL): finds X's title input by
  // attribute keywords and triggers React via native value setter +
  // input/change events. Adapted from x-article-in-obsidian's
  // findTitleField/setArticleTitle in vendor/x-article-publish/template.ts
  // (lines 35-91). UI updates immediately — no page reload needed.
  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect?.();
    if (!r || r.width < 4 || r.height < 4) return false;
    const s = getComputedStyle?.(el);
    if (s && (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0')) return false;
    return true;
  }
  function findTitleField() {
    const editor = findEditor();
    const candidates = Array.from(
      document.querySelectorAll("input[type='text'], textarea, [contenteditable='true']")
    ).filter((n) => n !== editor && isVisible(n));
    const kws = ['title', '标题', 'add title', '输入标题'];
    let best = null;
    let bestScore = -1;
    for (const node of candidates) {
      const txt = (
        (node.getAttribute?.('aria-label') || '') + ' ' +
        (node.getAttribute?.('placeholder') || '') + ' ' +
        (node.getAttribute?.('data-testid') || '')
      ).toLowerCase();
      const rect = node.getBoundingClientRect();
      let score = 0;
      if (kws.some((k) => txt.includes(k))) score += 10;
      if (rect.top < 420) score += 4;
      if (rect.width > 240) score += 2;
      if (score > bestScore) { bestScore = score; best = node; }
    }
    return bestScore > 0 ? best : null;
  }

  async function setTitleViaUI(title) {
    const field = findTitleField();
    if (!field) return { ok: false, err: 'title field not found' };
    if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
      const proto = field instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      // Use the prototype's native value setter so React's internal
      // tracker sees the change. Direct `field.value = x` is silently
      // dropped on controlled inputs.
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      setter?.call(field, String(title));
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      field.focus();
      await sleep(80);
      document.execCommand('selectAll', false);
      document.execCommand('insertText', false, String(title));
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.dispatchEvent(new Event('change', { bubbles: true }));
    }
    await sleep(250);
    return { ok: true };
  }

  // Read the CURRENT mediaIds of all MEDIA atomic blocks in document
  // order. Used after batch relocate + autosave settle to grab the
  // bound (final, server-blessed) mediaIds for cover-binding — the ids
  // captured during initial upload are intermediate and may have been
  // promoted by X by the time we POST cover.
  function readCurrentMediaIds(sn) {
    const cs = sn.props.editorState.getCurrentContent();
    const out = []; // [{ blockKey, ek, mediaId }] in doc order
    cs.getBlockMap().forEach((b, blockKey) => {
      if (b.getType() !== 'atomic') return;
      b.findEntityRanges(
        (c) => !!c.getEntity(),
        (start) => {
          const ek = b.getCharacterList().get(start)?.getEntity?.();
          if (!ek) return;
          try {
            const ent = cs.getEntity(ek);
            if (ent.getType() !== 'MEDIA') return;
            const data = ent.getData();
            const mi = data?.mediaItems?.[0] || data?.media_items?.[0];
            const mid = mi?.mediaId || mi?.media_id;
            if (mid) out.push({ blockKey, ek, mediaId: mid });
          } catch { /* ignore */ }
        },
      );
    });
    return out;
  }

  // Surgically delete a single block from the doc. Used to remove the
  // cover image's atomic from body once it's been bound to the cover
  // slot — otherwise the same image renders both at the article top
  // and inline. Mirrors removeLeftoverMarkers's pattern (OrderedMap
  // delete + selection reset + push 'remove-range').
  function deleteBlockByKey(sn, blockKey) {
    const es = sn.props.editorState;
    const ESCtor = es.constructor;
    const SSCtor = es.getSelection().constructor;
    const cs = es.getCurrentContent();
    const blockMap = cs.getBlockMap();
    if (!blockMap.has(blockKey)) return { ok: false, err: 'block not found' };
    const nbm = blockMap.delete(blockKey);
    const lastKey = nbm.last() ? nbm.last().getKey() : null;
    const safeSel = lastKey ? SSCtor.createEmpty(lastKey) : es.getSelection();
    const newContent = cs
      .set('blockMap', nbm)
      .set('selectionBefore', safeSel)
      .set('selectionAfter', safeSel);
    let ns = ESCtor.push(es, newContent, 'remove-range');
    ns = ESCtor.moveSelectionToEnd(ns);
    sn.props.onChange(ns);
    return { ok: true };
  }

  async function setArticleCover(articleEntityId, mediaId, mediaCategory = 'DraftTweetImage') {
    return gqlPost('Es8InPh7mEkK9PxclxFAVQ', 'ArticleEntityUpdateCoverMedia', {
      variables: {
        articleEntityId,
        coverMedia: { media_id: String(mediaId), media_category: mediaCategory },
      },
      features: ARTICLE_FEATURES,
      queryId: 'Es8InPh7mEkK9PxclxFAVQ',
    });
  }
  // ────────────────────────────────────────────────────────────────────────

  async function runFlow(payload) {
    const { html, plain, plan, markerPrefix } = payload;
    const sn = getDraftStateNode();
    if (!sn) {
      post('error', { error: 'Draft stateNode not reachable in MAIN world' });
      return;
    }
    const articleId = getArticleIdFromUrl();
    if (!articleId && (payload.title || payload.cover)) {
      console.warn(TAG, 'no articleId in URL; title/cover will be skipped');
    }

    progress('main_paste_html');
    pasteHtml(html, plain);
    await sleep(350); // let X process the HTML + commit blockMap

    const counts = { atomicOk: 0, atomicFail: 0, imgOk: 0, imgFail: 0 };

    // PHASE 1 — replace ALL atomic markers (DIVIDER / MARKDOWN / TWEET)
    // in a SINGLE onChange call. This dramatically reduces churn vs one
    // onChange per marker: only one autosave trigger, only one React
    // re-render, only one chance for X's internal state machine to get
    // confused while we're modifying via Fiber.
    const atomicSteps = plan.filter((s) => s.op.type === 'atomic');
    const imageSteps = plan.filter((s) => s.op.type === 'image');

    if (atomicSteps.length) {
      progress('main_inserting_atomics', { n: atomicSteps.length });
      const batchResult = batchReplaceAtomics(sn, atomicSteps);
      counts.atomicOk = batchResult.okCount;
      counts.atomicFail = batchResult.failCount;
      if (batchResult.errs?.length) {
        console.warn(TAG, 'atomic batch failures:', batchResult.errs);
      }
    }

    // Wait for X's autosave network call (ArticleEntityUpdateContent) to
    // actually complete before starting image uploads. This is the real
    // signal that text + atomics are committed server-side.
    if (atomicSteps.length || imageSteps.length) {
      progress('waiting_save');
      const saved = await waitForArticleSave(8000);
      console.log(TAG, 'article save (initial):', saved);
      // Defensive: if no save fired (timeout), do a short content-stable
      // wait as fallback so we don't proceed mid-render.
      if (!saved.ok) {
        const settle = await waitForAutosaveSettle(sn, { timeoutMs: 1500, stableMs: 400 });
        console.log(TAG, 'fallback content-stable:', settle);
      }
    }

    // PHASE 2 — upload every image without relocating; let X pile every
    // new MEDIA atomic at end-of-doc. Once they're all uploaded and X has
    // autosaved (mediaIds bound), do a single batch reorder to move each
    // atomic to its marker position. This kills the per-image race where
    // the NEXT onFilesAdded reverted the PREVIOUS relocate.
    //
    // Snapshot existing atomic block keys so the relocate logic can tell
    // "atomics we just added" from "atomics already there" (e.g. the
    // TWEET inserted during PHASE 1). With this snapshot, relocate no
    // longer depends on stored entity keys — robust to X reassigning eks
    // when uploads time out (HAR 测试1632.har: 24s upload timeout caused
    // X to rebuild atomics with new eks, breaking the ek-based match).
    const preAtomicKeys = new Set();
    sn.props.editorState.getCurrentContent().getBlockMap().forEach((b, k) => {
      if (b.getType() === 'atomic') preAtomicKeys.add(k);
    });
    const uploaded = []; // [{ marker, ek, fallbackText }]
    for (let i = 0; i < imageSteps.length; i++) {
      const step = imageSteps[i];
      const f = step.op.file;
      progress('main_uploading_image', { i: i + 1, total: imageSteps.length });
      let file = base64ToFile(f.base64, f.fileName, f.mime);
      let r = await insertImageAtMarker(sn, step.marker, file, { timeoutMs: 25000 });

      // Retry once on mediaId timeout — X's queue usually clears within ~1s.
      if (!r.ok && /timeout/i.test(r.err || '')) {
        progress('main_image_retry', { i: i + 1 });
        await sleep(1500);
        file = base64ToFile(f.base64, f.fileName, f.mime);
        r = await insertImageAtMarker(sn, step.marker, file, { timeoutMs: 25000 });
      }

      if (r.ok) {
        counts.imgOk += 1;
        uploaded.push({
          marker: step.marker,
          ek: r.ek,
          mediaId: r.mediaId || null,
          source: step.op.source || null,
          fallbackText: step.op.fallbackText,
        });
      } else {
        counts.imgFail += 1;
        console.warn(TAG, 'image insert failed:', step.marker, r.err);
        // Replace marker with the original markdown ref so the user
        // keeps a recoverable reference instead of a silent miss.
        if (step.op.fallbackText) {
          replaceMarkerWithText(sn, step.marker, step.op.fallbackText);
        }
      }
    }

    // Wait for X's autosave to bind every staged mediaId before we
    // shuffle blocks around. Without bind, the relocate's autosave can
    // race the bind and X may "normalize" our atomic back to end-of-doc.
    if (uploaded.length) {
      progress('main_waiting_bind');
      // Sleep > debounce (3000ms) so any in-flight autosave fires.
      await sleep(3500);
      await waitForArticleSave(8000).catch(() => {});
    }

    // Batch relocate — single onChange moves every uploaded atomic to its
    // marker position. Then verify it stuck: HAR 测试1623.har showed the
    // relocate's autosave (save 7) carried the correct order, but a
    // follow-up cleanup onChange (kickEditorRender) caused X to revert to
    // a state with atomics back at end-of-doc. So: verify, and on
    // detection of revert, redo the relocate WITHOUT any cleanup pass
    // that might trigger another revert.
    let relocateOk = false;
    if (uploaded.length) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        progress(attempt === 1 ? 'main_relocate' : 'main_relocate_retry', { attempt });
        const rel = batchRelocateImages(sn, uploaded, preAtomicKeys);
        console.log(TAG, `batch relocate attempt ${attempt}:`, rel);
        await sleep(800);
        await waitForArticleSave(5000).catch(() => {});
        // Verify each uploaded atomic is at its marker block's expected
        // position (origin atomic block index === markerIndex pre-relocate).
        // Simpler check: ensure no atomic that was uploaded is sitting
        // adjacent to all other uploaded atomics at end-of-doc, AND no
        // marker text reappeared in the doc.
        const verdict = verifyRelocate(sn, uploaded, markerPrefix);
        console.log(TAG, `verify attempt ${attempt}:`, verdict);
        if (verdict.ok) { relocateOk = true; break; }
        // Sleep before retry to let any in-flight X update settle
        await sleep(1500);
      }
    }

    // Title: write via the UI (native value setter + input/change
    // events) so React picks it up and the editor reflects it
    // immediately. The earlier GraphQL-only path worked server-side but
    // left the title input visually blank until page reload — see
    // 测试1650.har analysis. UI write is the same trick the Obsidian
    // plugin uses in vendor/x-article-publish/template.ts.
    if (payload.title) {
      try {
        progress('main_setting_title');
        const r = await setTitleViaUI(payload.title);
        console.log(TAG, 'setTitleViaUI:', r);
        // Belt-and-suspenders: also POST to the GraphQL endpoint so the
        // server has the title even if X's autosave doesn't fire fast
        // enough on the input event.
        if (articleId) {
          const gr = await setArticleTitle(articleId, payload.title);
          console.log(TAG, 'setArticleTitle (gql):', gr);
        }
      } catch (e) {
        console.warn(TAG, 'set title failed:', e);
      }
    }
    if (payload.cover && articleId) {
      // Resolve cover URL → body image index → CURRENT mediaId (the one
      // X has bound server-side). The mediaId we captured at upload time
      // is an intermediate id that X promotes during processing; using
      // the stale id was why 测试1650.har's cover didn't actually render
      // (200 response, but the id no longer pointed at a live media).
      const idx = uploaded.findIndex((u) => u.source && u.source === payload.cover);
      if (idx >= 0) {
        const current = readCurrentMediaIds(sn);
        const fresh = current[idx]?.mediaId || uploaded[idx]?.mediaId;
        if (fresh) {
          try {
            progress('main_setting_cover');
            const cr = await setArticleCover(articleId, fresh);
            console.log(TAG, 'setArticleCover:', cr, 'mediaIdSuffix=…' + fresh.slice(-8));
            // Cover is bound server-side — remove its atomic from body
            // so the same image doesn't render twice (once as cover,
            // once inline). We use the block key from `current[idx]`
            // captured before this onChange. Wait briefly so the cover
            // API's autosave doesn't race the delete.
            if (cr?.ok && current[idx]?.blockKey) {
              await sleep(600);
              const dr = deleteBlockByKey(sn, current[idx].blockKey);
              console.log(TAG, 'deleteCoverBlock:', dr);
              await waitForArticleSave(5000).catch(() => {});
            }
          } catch (e) {
            console.warn(TAG, 'setArticleCover failed:', e);
          }
        } else {
          console.warn(TAG, 'cover image has no mediaId; skipping');
        }
      } else {
        console.warn(TAG, 'cover URL has no matching body image; skipping:', payload.cover);
      }
    }

    // Cleanup phase runs ONLY when relocate didn't fully succeed (markers
    // may be lingering) OR there were no images at all. When relocate
    // succeeded, doing extra onChange calls here was the trigger for the
    // 测试1623.har regression — skip them entirely.
    let totalCleaned = 0;
    if (!relocateOk) {
      progress('main_cleanup');
      for (let pass = 0; pass < 5; pass++) {
        const removed = removeLeftoverMarkers(sn, markerPrefix);
        totalCleaned += removed;
        if (removed === 0 && pass > 0) break;
        await sleep(pass === 0 ? 800 : 2200);
      }
      kickEditorRender(sn);
      await waitForArticleSave(5000);
    }
    counts.markersCleaned = totalCleaned;

    // Last-chance verification: after the final save settled, run the
    // cleanup ONCE more in case X's response carried back a stale state.
    const finalSweep = relocateOk ? 0 : removeLeftoverMarkers(sn, markerPrefix);
    if (finalSweep > 0) {
      counts.markersCleaned += finalSweep;
      console.warn(TAG, 'final sweep removed', finalSweep, 'markers — X reloaded stale state');
      // Force one more save so the final clean state actually persists
      await waitForArticleSave(4000);
    }

    post('done', { summary: counts });
  }

  // Listen for run requests from bridge
  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const data = ev.data;
    if (!data || data.source !== SOURCE_IN) return;
    if (data.kind === 'ready?') {
      post('ready');
      return;
    }
    if (data.kind === 'run') {
      runFlow(data.payload).catch((err) => {
        console.error(TAG, 'runFlow crashed', err);
        post('error', { error: String(err?.message || err) });
      });
      return;
    }
  });

  console.log(TAG, 'main-world injector ready');
  post('ready');
})();
