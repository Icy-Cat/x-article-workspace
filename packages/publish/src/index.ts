import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import type { PublishPayload } from "@x-article/shared-types";
import { getBrowserPublishFunctionTemplate } from "./template";

const PLAYWRIGHT_SERVER_NAME = "playwright";
const PLAYWRIGHT_TOKEN_ENV = "PLAYWRIGHT_MCP_EXTENSION_TOKEN";
const PLAYWRIGHT_EXTENSION_ID = "mmlmfjhmonkocbjadbfplnigmagldckm";
const MCP_REQUEST_TIMEOUT_MS = 5000;
const MCP_EVALUATE_TIMEOUT_MS = 180000;

type ParsedServerEntry = {
  command: string;
  args: string[];
  env: Record<string, string>;
};

type ParsedMcpConfig = {
  path: string;
  servers: Record<string, ParsedServerEntry>;
};

type JsonRpcResponse = {
  id?: number;
  result?: unknown;
  error?: { message?: string };
};

export interface PublishLogger {
  enabled: boolean;
  append: (event: string, details: Record<string, unknown>) => Promise<void>;
}

export interface PublishRuntimeOptions {
  savedToken?: string;
  logger?: PublishLogger;
}

export function buildBrowserPublishScript(payload: PublishPayload): string {
  return `(${buildBrowserPublishFunction(payload)})();`;
}

export function buildBrowserPublishFunction(payload: PublishPayload): string {
  return getBrowserPublishFunctionTemplate(payload);
}

export async function publishViaDetectedMcp(
  functionSource: string,
  options: PublishRuntimeOptions = {}
): Promise<{ source: string }> {
  const logger = options.logger;
  await logger?.append("publish.preflight", { nodeEnvironment: inspectLocalNodeEnvironment() });
  if (!inspectLocalNodeEnvironment().available) {
    throw new Error("Browser publishing requires a local Node.js environment.");
  }

  const runtime = detectPlaywrightRuntime(options.savedToken);
  if (!runtime) {
    throw new Error("No browser bridge was detected. Configure Playwright MCP first.");
  }

  const client = await StdioMcpClient.connect(runtime);
  try {
    await client.assertToolsAvailable(["browser_navigate", "browser_wait_for", "browser_evaluate"]);
    await client.callTool("browser_navigate", { url: "https://x.com/compose/articles" });
    await client.callTool("browser_wait_for", { time: 2 });
    await client.callTool("browser_evaluate", {
      function: normalizeEvaluateSource(`async () => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const findCreateButton = () =>
          document.querySelector("button[aria-label='create']") ||
          Array.from(document.querySelectorAll("button[role='button'], button")).find((button) =>
            (button.getAttribute("aria-label") || "").toLowerCase() === "create"
          );
        const button = findCreateButton();
        if (!button) throw new Error("Create button not found.");
        button.click();
        for (let attempt = 0; attempt < 30; attempt += 1) {
          const editor =
            document.querySelector("[data-contents='true'] [contenteditable='true']") ||
            document.querySelector("[contenteditable='true']");
          if (editor) return true;
          await sleep(200);
        }
        throw new Error("Editor did not become ready after clicking create.");
      }`)
    }, MCP_EVALUATE_TIMEOUT_MS);
    const result = parsePlaywrightToolResult(
      await client.callTool("browser_evaluate", { function: normalizeEvaluateSource(functionSource) }, MCP_EVALUATE_TIMEOUT_MS)
    );
    if (!isSuccessfulPublishResult(result)) {
      throw new Error(`Browser publish script did not report success. Result: ${JSON.stringify(result)}`);
    }
  } finally {
    await client.close();
  }
  await logger?.append("publish.success", { source: runtime.source });
  return { source: runtime.source };
}

function detectPlaywrightRuntime(savedToken?: string): { command: string; args: string[]; env: Record<string, string>; source: string } | null {
  const configs = getDefaultMcpConfigPaths()
    .map((configPath) => readMcpConfig(configPath))
    .filter((config): config is ParsedMcpConfig => config !== null);
  const token =
    savedToken?.trim() ||
    process.env[PLAYWRIGHT_TOKEN_ENV] ||
    findPlaywrightTokenInConfigs(configs) ||
    discoverPlaywrightExtensionToken();

  for (const config of configs) {
    const server = config.servers[PLAYWRIGHT_SERVER_NAME];
    if (!server) continue;
    return normalizeRuntimeConfig({
      command: server.command,
      args: server.args,
      env: { ...server.env, ...(token ? { [PLAYWRIGHT_TOKEN_ENV]: token } : {}) },
      source: config.path
    });
  }
  if (!token) return null;
  return normalizeRuntimeConfig({
    command: "npx",
    args: ["-y", "@playwright/mcp@latest", "--extension"],
    env: { [PLAYWRIGHT_TOKEN_ENV]: token },
    source: "auto-detected token"
  });
}

function readMcpConfig(configPath: string): ParsedMcpConfig | null {
  if (!fs.existsSync(configPath)) return null;
  try {
    const content = fs.readFileSync(configPath, "utf8");
    if (configPath.endsWith(".toml")) {
      return { path: configPath, servers: readTomlServers(content) };
    }
    const parsed = JSON.parse(content) as {
      mcpServers?: Record<string, { command?: string; args?: string[]; env?: Record<string, string> }>;
      mcp?: Record<string, { command?: string | string[]; args?: string[]; env?: Record<string, string> }>;
    };
    const servers: Record<string, ParsedServerEntry> = {};
    for (const [name, server] of Object.entries(parsed.mcpServers ?? {})) {
      if (!server.command) continue;
      servers[name] = { command: server.command, args: server.args ?? [], env: normalizeEnv(server.env) };
    }
    for (const [name, server] of Object.entries(parsed.mcp ?? {})) {
      const parts = Array.isArray(server.command) ? server.command : server.command ? [server.command] : [];
      if (parts.length === 0) continue;
      const [command, ...embeddedArgs] = parts;
      if (!command) continue;
      servers[name] = { command, args: [...embeddedArgs, ...(server.args ?? [])], env: normalizeEnv(server.env) };
    }
    return { path: configPath, servers };
  } catch {
    return null;
  }
}

function normalizeEnv(env?: Record<string, string>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (typeof value === "string" && value.length > 0) normalized[key] = value;
  }
  return normalized;
}

function readTomlServers(content: string): Record<string, ParsedServerEntry> {
  const servers: Record<string, ParsedServerEntry> = {};
  const sectionRegex = /^\s*\[mcp_servers\.([^.]+)\]\s*$/gm;
  const matches = Array.from(content.matchAll(sectionRegex));
  for (let index = 0; index < matches.length; index += 1) {
    const name = matches[index]?.[1];
    if (!name) continue;
    const start = matches[index]?.index ?? 0;
    const end = matches[index + 1]?.index ?? content.length;
    const section = content.slice(start, end);
    const commandMatch = section.match(/^\s*command\s*=\s*"([^"\n]+)"/m);
    const argsMatch = section.match(/^\s*args\s*=\s*\[([^\]]*)\]/m);
    if (!commandMatch?.[1]) continue;
    servers[name] = {
      command: commandMatch[1],
      args: parseTomlArray(argsMatch?.[1] ?? ""),
      env: {}
    };
  }
  return servers;
}

function parseTomlArray(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim().replace(/^"/, "").replace(/"$/, ""))
    .filter(Boolean);
}

function getDefaultMcpConfigPaths(): string[] {
  const home = os.homedir();
  const cwd = process.cwd();
  return [
    path.join(home, ".codex", "config.toml"),
    path.join(home, ".codex", "mcp.json"),
    path.join(home, ".cursor", "mcp.json"),
    path.join(home, ".claude.json"),
    path.join(home, ".gemini", "settings.json"),
    path.join(cwd, ".cursor", "mcp.json"),
    path.join(cwd, ".vscode", "mcp.json"),
    path.join(cwd, ".mcp.json")
  ];
}

function findPlaywrightTokenInConfigs(configs: ParsedMcpConfig[]): string | null {
  for (const config of configs) {
    const token = config.servers[PLAYWRIGHT_SERVER_NAME]?.env[PLAYWRIGHT_TOKEN_ENV];
    if (token) return token;
  }
  return null;
}

function normalizeRuntimeConfig(runtime: { command: string; args: string[]; env: Record<string, string>; source: string }) {
  if ((runtime.command.endsWith("npx") || runtime.command.endsWith("npx.cmd")) && !runtime.args.includes("-y")) {
    return { ...runtime, args: ["-y", ...runtime.args] };
  }
  return runtime;
}

function inspectLocalNodeEnvironment(): { available: boolean } {
  return { available: ["node", "npm", "npx"].every((name) => resolveExecutable(name) !== null) };
}

function resolveExecutable(name: string): string | null {
  const extensions = process.platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];
  for (const entry of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!entry) continue;
    for (const extension of extensions) {
      const candidate = path.join(entry, `${name}${extension}`);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function discoverPlaywrightExtensionToken(): string | null {
  const home = os.homedir();
  const appData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  const bases = [
    path.join(appData, "Google", "Chrome", "User Data"),
    path.join(appData, "Microsoft", "Edge", "User Data")
  ];
  const profiles = ["Default", "Profile 1", "Profile 2", "Profile 3"];
  const tokenRe = /([A-Za-z0-9_-]{40,50})/;
  const extIdBuf = Buffer.from(PLAYWRIGHT_EXTENSION_ID);
  const keyBuf = Buffer.from("auth-token");

  for (const base of bases) {
    for (const profile of profiles) {
      const dir = path.join(base, profile, "Local Storage", "leveldb");
      if (!fs.existsSync(dir)) continue;
      const files = fs.readdirSync(dir)
        .filter((file) => file.endsWith(".ldb") || file.endsWith(".log"))
        .map((file) => path.join(dir, file));
      for (const filePath of files) {
        const data = fs.readFileSync(filePath);
        if (data.indexOf(extIdBuf) === -1) continue;
        let cursor = 0;
        while (true) {
          const keyPos = data.indexOf(keyBuf, cursor);
          if (keyPos === -1) break;
          const candidate = data.subarray(keyPos + keyBuf.length, keyPos + keyBuf.length + 200).toString("latin1").match(tokenRe)?.[1];
          if (candidate) return candidate;
          cursor = keyPos + 1;
        }
      }
    }
  }
  return null;
}

class StdioMcpClient {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: JsonRpcResponse) => void; reject: (reason?: unknown) => void; timer: NodeJS.Timeout }>();
  private buffer = "";
  private readonly stderrChunks: string[] = [];
  private closed = false;

  private constructor(private readonly proc: ChildProcessWithoutNullStreams) {}

  static async connect(runtime: { command: string; args: string[]; env: Record<string, string> }): Promise<StdioMcpClient> {
    const proc = spawn(runtime.command, runtime.args, {
      stdio: "pipe",
      env: { ...process.env, ...runtime.env },
      shell: false
    });
    const client = new StdioMcpClient(proc);
    client.attach();
    await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "x-article-vscode", version: "0.1.0" }
    }, MCP_REQUEST_TIMEOUT_MS);
    client.writeFrame({ jsonrpc: "2.0", method: "notifications/initialized" });
    return client;
  }

  private attach(): void {
    this.proc.stdout.on("data", (chunk) => {
      this.buffer += chunk.toString("utf8");
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const response = JSON.parse(line) as JsonRpcResponse;
          if (typeof response.id !== "number") continue;
          const pending = this.pending.get(response.id);
          if (!pending) continue;
          clearTimeout(pending.timer);
          this.pending.delete(response.id);
          pending.resolve(response);
        } catch {
          continue;
        }
      }
    });
    this.proc.stderr.on("data", (chunk) => {
      this.stderrChunks.push(chunk.toString("utf8"));
      if (this.stderrChunks.length > 20) this.stderrChunks.shift();
    });
    this.proc.on("close", () => {
      this.closed = true;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(this.getProcessErrorDetail()));
      }
      this.pending.clear();
    });
  }

  async callTool(name: string, args: Record<string, unknown>, timeoutMs = MCP_REQUEST_TIMEOUT_MS): Promise<unknown> {
    const response = await this.request("tools/call", { name, arguments: args }, timeoutMs);
    if (response.error?.message) throw new Error(response.error.message);
    return response.result;
  }

  async assertToolsAvailable(toolNames: readonly string[]): Promise<void> {
    const response = await this.request("tools/list", {}, MCP_REQUEST_TIMEOUT_MS);
    if (response.error?.message) throw new Error(response.error.message);
    const result = response.result as { tools?: Array<{ name?: string }> } | undefined;
    const available = new Set((result?.tools ?? []).map((tool) => tool.name).filter(Boolean) as string[]);
    const missing = toolNames.filter((name) => !available.has(name));
    if (missing.length > 0) {
      throw new Error(`Playwright MCP is missing required tools: ${missing.join(", ")}.`);
    }
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${Math.round(timeoutMs / 1000)}s.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.writeFrame({ jsonrpc: "2.0", id, method, params }, (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  private writeFrame(message: Record<string, unknown>, callback?: (error?: Error) => void): void {
    if (this.closed || this.proc.stdin.destroyed || !this.proc.stdin.writable) {
      callback?.(new Error(this.getProcessErrorDetail()));
      return;
    }
    this.proc.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
      callback?.(error ? new Error(String(error)) : undefined);
    });
  }

  async close(): Promise<void> {
    this.proc.kill();
  }

  private getProcessErrorDetail(): string {
    const stderr = this.stderrChunks.join("").trim();
    return stderr ? `MCP process closed. ${stderr}` : "MCP process closed.";
  }
}

function parsePlaywrightToolResult(result: unknown): unknown {
  if (!result || typeof result !== "object") return result;
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  if (!Array.isArray(content)) return result;
  const textPart = content.find((part) => part.type === "text" && typeof part.text === "string");
  if (!textPart?.text) return result;
  try {
    return JSON.parse(textPart.text);
  } catch {
    return textPart.text;
  }
}

function normalizeEvaluateSource(source: string): string {
  const stripped = source.trim();
  if (!stripped) return "() => undefined";
  if (/^(async\s+)?\([^)]*\)\s*=>/.test(stripped)) return stripped;
  if (stripped.startsWith("function ") || stripped.startsWith("async function ")) return stripped;
  return `() => (${stripped})`;
}

function isSuccessfulPublishResult(result: unknown): result is { ok: true } {
  return Boolean(result && typeof result === "object" && "ok" in result && (result as { ok?: unknown }).ok === true);
}
