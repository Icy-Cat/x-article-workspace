// bb-browser bridge: spawn bb-browser CLI, parse JSON results.
//
// 设计原则：
//   - 单进程一次调用一条命令，等结果返回
//   - eval 拿到的 result 字段是字符串（如果 JS 返回对象，浏览器会 JSON.stringify 再回 JSON.parse；
//     如果返回的就是 string，原样返回）
//   - 所有 JS 用 IIFE 包好，自己处理 try/catch，避免 bb-browser daemon 报"Daemon HTTP 400"

import { spawn } from "node:child_process";
import { join } from "node:path";

function runBB(args, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    // bb-browser is a Node CLI; resolve the .cmd shim path on Windows and
    // invoke node.exe directly to avoid cmd.exe argument mangling on
    // multiline / quote-heavy JS.
    const isWin = process.platform === "win32";
    let command, spawnArgs;
    if (isWin) {
      // Find bb-browser script (npm global)
      const candidate = process.env.BB_BROWSER_SCRIPT
        || join(process.env.APPDATA || "", "npm", "node_modules", "bb-browser", "dist", "cli.js");
      command = process.execPath; // node.exe
      spawnArgs = [candidate, ...args];
    } else {
      command = "bb-browser";
      spawnArgs = args;
    }
    const p = spawn(command, spawnArgs, { stdio: ["ignore", "pipe", "pipe"], windowsVerbatimArguments: false });
    let out = "", err = "";
    p.stdout.on("data", (c) => (out += c.toString("utf8")));
    p.stderr.on("data", (c) => (err += c.toString("utf8")));
    const t = setTimeout(() => {
      p.kill("SIGKILL");
      reject(new Error(`bb-browser timeout: ${args.slice(0, 2).join(" ")}`));
    }, timeoutMs);
    p.on("close", (code) => {
      clearTimeout(t);
      if (code !== 0 && !out.trim()) {
        reject(new Error(`bb-browser exited ${code}: ${err.slice(0, 500)}`));
        return;
      }
      try {
        resolve(JSON.parse(out));
      } catch {
        resolve({ raw: out, stderr: err, exitCode: code });
      }
    });
  });
}

export async function evalJS(js, { tab, timeoutMs = 30000 } = {}) {
  const args = ["eval", js, "--json"];
  if (tab) args.push("--tab", tab);
  const r = await runBB(args, { timeoutMs });
  if (!r.success) throw new Error(`eval failed: ${r.error || JSON.stringify(r).slice(0, 300)}`);
  // r.data.result is either a JSON-stringified value or a primitive
  const raw = r.data?.result;
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch { return raw; }
  }
  return raw;
}

export async function open(url, { tab } = {}) {
  const args = ["open", url, "--json"];
  if (tab) args.push("--tab", tab);
  return runBB(args);
}

export async function press(key, { tab } = {}) {
  const args = ["press", key, "--json"];
  if (tab) args.push("--tab", tab);
  return runBB(args);
}

export async function tabList() {
  const r = await runBB(["tab", "list", "--json"]);
  return r.data?.tabs || [];
}

export async function findArticleTab() {
  const tabs = await tabList();
  const hit = tabs.find((t) => /\/compose\/articles/.test(t.url));
  return hit?.tab || null;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
