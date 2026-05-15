# ADR 0002 — D4 Injection Rework

| 字段 | 值 |
|---|---|
| Status | **Accepted** |
| Date | 2026-05-16 |
| Author | @Coder（drafted），@Dev（reviewed），@Codex（contract review TBD on #16），@冷酷小猫（accepted） |
| Supersedes | [ADR-0001](./0001-host-integration-approach.md) |
| Superseded by | — |

---

## 1. Context

ADR-0001 提出了 skill 接入 X 编辑器的 A/B/C 三个候选（Delegate / Vendor / Continue api-mode），并推荐 A。在 review 过程中 @冷酷小猫 提出了**更彻底**的方向：

> "能不能让 obsidian 插件 也改为和拓展一样的实现方式 fiber注入+图片上传+api调整排版？"

这把决策范围从"skill 该不该委派给扩展"扩展为"**所有宿主（扩展 / skill / Obsidian 插件 / 未来 VS Code 插件）该不该共用同一份 X 编辑器注入逻辑**"。

衍生评估的 D1/D2/D3：
- **D1** — Obsidian 内嵌 webview 跑扩展同款代码
- **D2** — 纯 X HTTP API（无浏览器）
- **D3** — 插件 spawn 独立浏览器跑同款脚本

@Coder 补充了来自 task #3 (`x-viral-monitor` pro.x.com API 调研) 的关键数据点：**`ArticleEntityUpdateContent` 大概率是 TID-strict 端点**，姊妹仓 x-xillot 已证明 TID 逆向走不通——这把 D2 直接否决，并解释了 ADR-0001 中候选 C 在 2026-05-13 session 卡住的根因。

随后 @冷酷小猫 提出了 **D4**：

> "把浏览器插件的 JS 弄到 obsidian 插件里面，然后让 playwright mcp 通过 playwright-mcp-bridge 的浏览器插件复用用户的登录态，然后去执行那个 JS"

D4 在评估中胜出。

---

## 2. Decision

采用 **D4**。具体路径：

1. 抽出 `@x-article/inject-core` 共享包，落 `G:\Projects\0Tools\x-article-workspace\packages\inject-core\`
2. 共享包以 **adapter pattern** 设计——核心 pipeline 纯 platform-agnostic，所有宿主能力（fetchImage / resolveLocalImage / onProgress / i18n）走显式 adapter callback
3. **x-article-md-paste 扩展**改为 `import { runPipeline } from '@x-article/inject-core'`，扩展端实现 chrome.runtime / chrome.storage / banner DOM 这一套作为 adapter 注入
4. **x-article-in-obsidian 插件**改为通过 `playwright-mcp-bridge` 连用户真实 Chrome + `page.evaluate(injectCoreBundle, { markdown, ...adapters })`，Obsidian 端 adapter 用 `requestUrl` + 文件系统读 vault image
5. Obsidian 插件**删除**所有 "Playwright 模拟 UI 操作"（drag-drop / type / click）的旧实现路径

落地 task：#16（抽 inject-core）→ #17（Obsidian 改 D4）。

---

## 3. Rationale

1. **单源维护** — 注入逻辑只在 inject-core 一份。扩展和插件是 import 同源，不再可能"分叉两套"。
2. **登录态白送** — `playwright-mcp-bridge` 接管用户真实 Chrome，cookie / auth_token / ct0 全是真实状态，不再需要在插件里维护登录管线。
3. **Fiber 注入逻辑零改动** — 扩展的 `main/injector-main.js` 已经声明 `world: "MAIN"`，本来就在 page main world 跑。`page.evaluate` 也在 main world，**这段代码一字不改可移植**。
4. **删除 UI 模拟脆弱面** — 旧 Obsidian 插件靠 Playwright 模拟"点击 / 输入 / 拖拽"，X 改版任意一个按钮都会断；D4 走 Fiber/React state 写入，跟 X 自己的代码同生共死。
5. **顺手淘汰 api-mode 与 menu-mode** — workspace 的 dirty 5+2 文件（autosave-hook / render-table）成为沉没成本，但表格渲染逻辑会被 `vendor/render-table.js` 复用，不浪费；menu-mode 走 deprecation 弃用。

---

## 4. Validated Technical Points

D4 决策前完成的 3 点技术验证（详见 #dev:4397d92f thread）：

### 4.1 chrome.* API 用法审计

@Dev 初扫得出 2 处（`chrome.runtime.sendMessage` 做图片代理 + `chrome.runtime.getURL` 拼模块路径）；@Coder 复盘补全得到全仓 **19 处** `chrome.*` 调用，分布在：

| 区域 | 用法 | 是否进 inject-core |
|---|---|---|
| `src/background/` | service worker 生命周期 | ❌ 不进（与注入逻辑无关） |
| `src/license/` | license / trial / device ID 存储 | ❌ 不进（商业化层，Obsidian 不带） |
| `src/content/image-loader.js` | 跨 CORS 图片代理 | 🔧 改 fetcher callback adapter |
| `src/content/loader.js` | dynamic import 路径 | ❌ 不进（D4 直接 bundle 单文件） |

### 4.2 Fiber 注入跨 world 通信

扩展 manifest 已用 `world: "MAIN"` 声明 `src/main/injector-main.js` 直接跑在页面 main world。`page.evaluate(...)` 也在 main world，两端等价——**这段代码一字不改即可用于 D4**。原架构 isolated ↔ MAIN 双 world + postMessage 通信，在 D4 里可简化为单 world（一切在 main world 跑）。

### 4.3 playwright-mcp-bridge cookie 共享

bridge 模式本质是 "bridge 扩展装到用户真实 Chrome → 暴露 CDP → playwright-mcp 通过 bridge 连过去"，操作的就是用户真实 profile。cookie / auth_token / ct0 全是真实，无登录态维护成本。

---

## 5. Scope of `@x-article/inject-core` (adapter contract)

@Codex 在 #16 review 视角下收紧了边界——**core 只保留纯 pipeline / 解析 / 渲染 / 检测**，所有宿主能力走显式 adapter：

### 进 inject-core（纯逻辑层）

| 文件 | 出处 | 说明 |
|---|---|---|
| `main/injector-main.js` | `src/main/` | Fiber 注入 + 标记替换 + 图片 onFilesAdded |
| `content/orchestrator-core.js` | fork from `src/content/orchestrator.js` | 编排器，去掉 license / banner DOM / local-prompt 调用 |
| `content/segments-to-html.js` | `src/content/` | MD segment → HTML payload |
| `content/image-loader.js` | `src/content/` 🔧 | `chrome.runtime.sendMessage` → `fetcher` adapter |
| `content/file-import.js` | `src/content/` | .md 文件读取流程 |
| `content/detect.js` | `src/content/` | Markdown 启发式判断 |
| `vendor/parse-md.js` | `src/vendor/` | Markdown 解析器（已 vendored from workspace） |
| `vendor/render-table.js` | `src/vendor/` | 表格 → Canvas → PNG |
| `local-image/resolver.js`（部分） | `src/local-image/` | 仅保留纯字符串判断（`isLocalPath`），不带 File System Access |

### 不进 inject-core（宿主层）

- `src/background/` — service worker 生命周期
- `src/license/` — 商业化（试用 / 计费）
- `src/content/{import-button,banner,local-prompt,i18n,loader,file-dropzone,index}.js` — UI / 入口 / URL 闸门
- `src/content/file-import.js` — 扩展端的 .md drop / picker 到 X 编辑器的 DOM 编排（locale-invariant SVG 按钮查找 + `history.pushState` 导航 + synthetic ClipboardEvent）。D4 Obsidian 端走 Playwright `page.goto` + 直接 `page.evaluate(runPipeline)`，两端无共享抽象，host 各自实现（2026-05-16 commit 2c 决策）
- 整个 manifest.json — 加载方式

### Adapter Contract（调用方注入）

```ts
interface InjectCoreAdapters {
  /** Fetch a remote image and return its bytes. */
  fetchImage: (url: string) => Promise<{
    ok: boolean;
    base64?: string;
    mime?: string;
    fileName?: string;
    error?: string;
  }>;

  /** Resolve a local-path image reference to bytes. Optional. */
  resolveLocalImage?: (path: string) => Promise<{
    ok: boolean;
    base64?: string;
    mime?: string;
    fileName?: string;
    error?: string;
  }>;

  /** Progress / status callback. Host renders its own UI. */
  onProgress?: (status: 'idle' | 'work' | 'warn' | 'error', msg: string) => void;

  /** Localized string lookup. Host owns i18n. */
  i18n?: (key: string, vars?: Record<string, string>) => string;
}

export function runPipeline(opts: {
  markdown: string;
  articleId?: string;
  adapters: InjectCoreAdapters;
}): Promise<RunResult>;
```

---

## 6. Consequences

### Positive

- **Single source of truth** for X article injection logic across all hosts
- **Extension and plugin become release-coupled** — X version churn surfaces in one place, fix one place
- **Plugin code shrinks materially** — UI simulation layer goes away, dead code with it
- **Future VS Code extension** can adopt the same adapter pattern with minimal additional work
- **Open-source contribution friendlier** — pipeline logic is one repo / one package, no MV3 distraction

### Negative

- **Third-party dependency on `playwright-mcp-bridge`** for Obsidian path; bridge crash / version churn becomes a user-facing failure mode
- **Cross-repo regression risk** — any inject-core release must regress both extension and plugin paths before shipping
- **Build pipeline complexity** — inject-core ships as both ESM (for extension build) and IIFE bundle string (for `page.evaluate`); needs tsup / esbuild glue

### Migration

- Old Obsidian plugin users (v1.0.x) must install `playwright-mcp-bridge` Chrome extension before upgrading to v1.1.0
- v1.0.x line will not receive further updates after v1.1.0 ships
- v1.1.0 is a **major behavior change**, semver 0.x bump (1.0 → 1.1) reflects this

---

## 7. Implementation Tasks

- **task #16** — Build `@x-article/inject-core` package skeleton + extract pipeline + minimal extension-side migration to prove single-source
- **task #17** — Refactor `x-article-in-obsidian` to D4 model（depends on #16）
- **task #18** — This ADR + supersede 0001

Follow-up tasks（after #17 ships）:
- Deprecate `--mode=menu` in `skills/x-article-upload/scripts/upload-article.mjs`
- Move workspace dirty api-mode files (`autosave-hook.mjs`, `render-table.mjs`, modified `*.mjs`) into `experiments/` or revert
- VS Code app (`apps/vscode/`) adopt the same adapter pattern in a follow-up version

---

## 8. Alternatives Considered

| 方案 | 拒绝理由 |
|---|---|
| **A** (ADR-0001) — Skill delegate to installed extension | 仅解决 skill，未触达 Obsidian / VS Code |
| **B** (ADR-0001) — Skill vendor extension dist | 双仓代码同步成本，长期 painful |
| **C** (ADR-0001) — Continue api-mode | TID-strict 不可逆 + content_state shape 漂移；2026-05-13 session 已证明卡死 |
| **D1** — Obsidian 内嵌 webview | cookie / 登录态打通成本；webview Electron profile 不共享主 Chrome |
| **D2** — 纯 X HTTP API | `ArticleEntityUpdateContent` 大概率 TID-strict（pro.x.com 调研结论旁证），逆向不可行 |
| **D3** — Plugin spawn 独立浏览器 | 等价 Playwright/MCP 的另一种 fork，复杂、分发难、不复用 bridge |

---

## 9. Decision Log

| 时间 | 人 | 动作 |
|---|---|---|
| 2026-05-15 | @Coder | ADR-0001 drafted (A/B/C, recommend A) |
| 2026-05-15 | @Dev | ADR-0001 reviewed, endorsed A |
| 2026-05-16 | @冷酷小猫 | 提出"obsidian 改扩展同款"方向 → 衍生 D1/D2/D3 |
| 2026-05-16 | @Coder | 补 pro.x.com TID-strict 数据点，否决 D2 |
| 2026-05-16 | @冷酷小猫 | 提出 D4（bridge + page.evaluate） |
| 2026-05-16 | @Dev | D4 3 点技术验证 |
| 2026-05-16 | @Coder | scope 修订：补 license / local-image / banner / i18n stub 设计 |
| 2026-05-16 | @Codex | review 视角收紧边界为 adapter pattern |
| 2026-05-16 | @冷酷小猫 | 拍板 D4，建 task #16 / #17 / #18 |
| 2026-05-16 | @Coder | This ADR drafted (Accepted) |
