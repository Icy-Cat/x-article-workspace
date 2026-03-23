/**
 * browser-inject.js
 *
 * This is the browser-side async function body to inject into X article editor
 * via playwright's browser_evaluate tool.
 *
 * Usage: pass this as the `function` argument to browser_evaluate, with
 * PAYLOAD_JSON replaced by the actual JSON payload string.
 *
 * Template — replace PAYLOAD_JSON_PLACEHOLDER before using:
 */

/*
async () => {
  const payload = PAYLOAD_JSON_PLACEHOLDER;

  const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

  function findEditor() {
    return (
      document.querySelector("[data-contents='true'] [contenteditable='true']") ||
      document.querySelector("[contenteditable='true']")
    );
  }

  function findTitleField() {
    const editor = findEditor();
    const candidates = Array.from(
      document.querySelectorAll("input[type='text'], textarea, [contenteditable='true']")
    ).filter((node) => node !== editor);

    const titleKeywords = ["title", "标题", "add title", "输入标题"];
    const scored = candidates
      .filter((node) => {
        if (!(node instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(node);
        if (style.display === "none" || style.visibility === "hidden") return false;
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      })
      .map((node) => {
        const text = (
          node.getAttribute("aria-label") ||
          node.getAttribute("placeholder") ||
          node.getAttribute("data-testid") ||
          ""
        ).replace(/\s+/g, " ").trim().toLowerCase();
        const rect = node.getBoundingClientRect();
        let score = 0;
        if (titleKeywords.some((k) => text.includes(k))) score += 10;
        if (rect.top < 420) score += 4;
        if (rect.width > 240) score += 2;
        return { node, score };
      })
      .sort((a, b) => b.score - a.score);

    return scored[0]?.node || null;
  }

  async function setArticleTitle() {
    if (!payload.title) return;
    const titleField = findTitleField();
    if (!titleField) { console.warn("Title field not found."); return; }

    if (titleField instanceof HTMLInputElement || titleField instanceof HTMLTextAreaElement) {
      const proto = titleField instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      setter?.call(titleField, payload.title);
      titleField.dispatchEvent(new Event("input", { bubbles: true }));
      titleField.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      titleField.focus();
      await sleep(80);
      document.execCommand("selectAll", false);
      document.execCommand("insertText", false, payload.title);
      titleField.dispatchEvent(new Event("input", { bubbles: true }));
    }
    await sleep(250);
  }

  function createClipboardEvent(htmlValue, textValue) {
    const data = new DataTransfer();
    data.setData("text/html", htmlValue);
    data.setData("text/plain", textValue);
    return new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true });
  }

  async function insertArticleHtml() {
    const editor = findEditor();
    if (!editor) throw new Error("Editor not found.");

    editor.focus();
    await sleep(100);

    const before = (editor.textContent || "").replace(/\s/g, "").length;
    editor.dispatchEvent(createClipboardEvent(payload.html, payload.markdown));
    await sleep(500);

    const afterPaste = (editor.textContent || "").replace(/\s/g, "").length;
    if (afterPaste > before) return;

    // Fallback: execCommand
    document.execCommand("insertHTML", false, payload.html);
    await sleep(200);
  }

  function normalizeText(v) { return (v || "").replace(/\s+/g, " ").trim().toLowerCase(); }

  function isVisibleElement(node) {
    if (!(node instanceof HTMLElement)) return false;
    const style = window.getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden" || style.pointerEvents === "none") return false;
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function findClickableByText(labels) {
    const normalized = (Array.isArray(labels) ? labels : [labels]).map(normalizeText);
    const nodes = Array.from(
      document.querySelectorAll("button, [role='button'], [role='menuitem'], [role='option']")
    ).filter(isVisibleElement).filter((n) => {
      const text = normalizeText(n.textContent || "");
      return normalized.some(l => text === l || text.includes(l));
    });
    return nodes[0] || null;
  }

  async function waitForSelector(selector, attempts = 20, delayMs = 150) {
    for (let i = 0; i < attempts; i++) {
      const el = document.querySelector(selector);
      if (el) return el;
      await sleep(delayMs);
    }
    return null;
  }

  function findMarker(marker) {
    const editor = findEditor();
    if (!editor) return null;
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    let current;
    while ((current = walker.nextNode())) {
      const offset = current.textContent.indexOf(marker);
      if (offset >= 0) {
        return {
          node: current,
          offset,
          block: current.parentElement?.closest("[data-block='true']") || current.parentElement,
        };
      }
    }
    return null;
  }

  function getRectAfterToken(token) {
    const found = findMarker(token);
    if (!found) return null;
    const range = document.createRange();
    range.setStart(found.node, found.offset + token.length);
    range.collapse(true);
    return range.getBoundingClientRect();
  }

  async function clickAnchorToken(token) {
    const rect = getRectAfterToken(token);
    if (!rect) return false;
    const editor = findEditor();
    if (editor) editor.focus();
    await sleep(30);
    const x = rect.left + Math.min(rect.width, 8);
    const y = rect.top + rect.height / 2;
    const target = document.elementFromPoint(x, y);
    if (target) {
      target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: x, clientY: y }));
      target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: x, clientY: y }));
      target.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: x, clientY: y }));
    }
    await sleep(60);
    return true;
  }

  async function openInsertMenu(optionLabels, token) {
    if (token) await clickAnchorToken(token);
    const insertButton = findClickableByText(["插入", "Insert", "insert"]);
    if (!insertButton) throw new Error("Insert button not found.");
    insertButton.click();
    await sleep(300);
    const option = findClickableByText(optionLabels);
    if (!option) throw new Error("Insert menu option not found: " + optionLabels.join("/"));
    option.click();
    await sleep(400);
  }

  async function insertCodeBlock(item) {
    await openInsertMenu(["代码", "Code", "code"], item.marker);
    const languageInput = await waitForSelector("input[name='programming-language-input'], input[data-testid='programming-language-input']");
    if (languageInput && item.language) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(languageInput, item.language);
      languageInput.dispatchEvent(new Event("input", { bubbles: true }));
      languageInput.dispatchEvent(new Event("change", { bubbles: true }));
      await sleep(250);
      languageInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 13, bubbles: true }));
      await sleep(250);
    }
    let textarea = null;
    for (let i = 0; i < 20; i++) {
      textarea = document.querySelector("textarea[name='code-input']") ||
        document.querySelector("[role='dialog'] textarea") ||
        document.querySelector("textarea");
      if (textarea) break;
      await sleep(150);
    }
    if (!textarea) throw new Error("Code textarea not found.");
    if (textarea instanceof HTMLTextAreaElement) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(textarea, item.code);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      textarea.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      textarea.focus();
      document.execCommand("selectAll", false);
      document.execCommand("insertText", false, item.code);
    }
    await sleep(200);
    const dialog = textarea.closest("[role='dialog']") || document;
    const submitBtn = Array.from(dialog.querySelectorAll("button")).find(btn => {
      const text = normalizeText(btn.textContent || "");
      const disabled = btn.getAttribute("aria-disabled") === "true" || btn.disabled;
      return (text === "插入" || text.includes("insert")) && !disabled;
    });
    if (!submitBtn) throw new Error("Code submit button not found.");
    submitBtn.click();
    await sleep(500);
  }

  async function insertDivider(item) {
    await openInsertMenu(["分割线", "Divider", "divider", "horizontal rule"], item.marker);
  }

  function removeEmptyBlock(block) {
    if (!block) return;
    const text = (block.textContent || "").replace(/\u200b/g, "").trim();
    if (!block.querySelector("img,video,iframe,figure,pre,hr") && text.length === 0) {
      block.remove();
    }
  }

  function deleteMarker(marker) {
    const info = findMarker(marker);
    if (!info) return;
    const text = info.node.textContent || "";
    const off = text.indexOf(marker);
    if (off >= 0) {
      info.node.textContent = text.slice(0, off) + text.slice(off + marker.length);
    }
    removeEmptyBlock(info.node.parentElement?.closest("[data-block='true']"));
  }

  // ── Main flow ──────────────────────────────────────────────────────────────
  await setArticleTitle();
  await insertArticleHtml();
  await sleep(800);

  for (const item of payload.items) {
    if (item.type === "code") {
      await insertCodeBlock(item);
    } else if (item.type === "divider") {
      await insertDivider(item);
    } else {
      deleteMarker(item.marker);
    }
  }

  // Clean up any residual markers
  const editor = findEditor();
  if (editor) {
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    let cur;
    while ((cur = walker.nextNode())) {
      if (/MPH_MARKER_\d+/.test(cur.textContent)) {
        cur.textContent = cur.textContent.replace(/\s*MPH_MARKER_\d+\s*/g, "");
      }
    }
  }

  return { success: true, title: payload.title };
}
*/
