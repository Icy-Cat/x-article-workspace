// MCP bridge: wraps the StdioMcpClient (Playwright MCP) to expose a small
// API that mirrors the bb-browser CLI surface used by the rest of api-mode/*.
//
// All page-side JS goes through `evalJS(js)` which calls
// browser_evaluate({function: 'async ()=>{...}'}) and parses the result.

const FN_WRAP_PREFIX = "async () => { try { const __r = await ((";
const FN_WRAP_SUFFIX = ")()); return __r === undefined ? null : __r; } catch (e) { return { __evalError: String(e?.message || e), __evalStack: String(e?.stack || '') }; } }";

export function makeBridge(mcpClient) {
  async function evalJS(jsExpr, { timeoutMs } = {}) {
    // jsExpr is expected to be an IIFE expression like `(()=>{...})()` or `(async()=>{...})()`
    // We strip the trailing call and wrap it in a try/catch wrapper that returns the value.
    // Easier: just submit the IIFE inside an async wrapper and await it.
    const wrapped = `${FN_WRAP_PREFIX}${jsExpr}${FN_WRAP_SUFFIX}`;
    let raw = await mcpClient.evaluate(wrapped, timeoutMs);
    // v2's evalJS auto-parses string returns as JSON if possible
    if (typeof raw === "string") {
      try { raw = JSON.parse(raw); } catch { /* keep string */ }
    }
    if (raw && typeof raw === "object" && raw.__evalError) {
      const err = new Error(`browser eval error: ${raw.__evalError}`);
      err.browserStack = raw.__evalStack;
      throw err;
    }
    return raw;
  }

  async function press(key) {
    return mcpClient.call("browser_press_key", { key });
  }

  async function navigate(url) {
    return mcpClient.call("browser_navigate", { url });
  }

  async function waitFor(seconds) {
    return mcpClient.call("browser_wait_for", { time: seconds });
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  return { evalJS, press, navigate, waitFor, sleep };
}
