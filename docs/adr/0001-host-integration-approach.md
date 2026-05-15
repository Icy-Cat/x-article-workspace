# ADR 0001 — X 文章编辑器接入方式（A vs B）

| 字段 | 值 |
|---|---|
| Status | **Proposed**（待 @冷酷小猫 拍板） |
| Date | 2026-05-15 |
| Author | @Coder（drafted），@冷酷小猫（待 accept） |
| Supersedes | — |
| Superseded by | — |

---

## 1. Context

`x-article-workspace` 的 `skills/x-article-upload` 负责把本地 Markdown 发布到 X 文章草稿编辑器。当前 `scripts/upload-article.mjs` 通过 `--mode=api|menu` 支持两条路径：

- **`--mode=api`（默认，新路径）**：解析 markdown 为 segments，走 onFilesAdded 上传图片，直接 POST `ArticleEntityUpdateContent`。不动菜单。
- **`--mode=menu`（v1 legacy）**：直接粘 HTML + 点 Insert 菜单逐项插入代码块 / 分隔线 / 图片。

API 路径上**沉了大量未完成工作**：
- 5 个 dirty 文件 + 2 个 untracked 文件，全部在 `skills/x-article-upload/scripts/api-mode/`
- 新增 `autosave-hook.mjs`（hook X 的 autosave network 调用，避免固定 8s sleep 与服务端 settle 抢跑）
- 新增 `render-table.mjs`（用 SVG `<foreignObject>` 内联把表格渲染成 PNG）
- 即便如此，`saveContent` POST 仍以 `Internal: Unspecified` 失败（详见 §3 Evidence），原因怀疑是 `content_state` shape 跟真实 autosave body 没对齐。

与此同时，**姊妹仓 `x-article-md-paste`（Chrome 扩展）已经把这个问题解决**——它通过 page-world inject + React Fiber 注入 + autosave hook，在用户在 X 文章页 Ctrl+V 一份 MD 就完成全套发布。其 `injector-main.js` + autosave hook 是经过验证的"和 X 同生共死"实现。

5/13 session 在讨论"以后到底走哪条路"时被打断，决策悬而未决。该 ADR 的目的是把决策正式化。

> 历史背景细节：
> - Decision #1 5/13 中讨论过"修 API 调用 vs 改 Fiber 注入"，用户选了"先修 API"，于是有了现在的 dirty 工作（autosave-hook / render-table 都是这条路径上的产出）
> - Decision #2 出现于 session 末尾——既然 `x-article-md-paste` 扩展已经把整条路打通，**为什么不直接复用扩展？** 这就是本 ADR 要回答的问题
> - Session 在 user 回 "B" 后被 assistant 反驳并重新发问，user interrupt，未达成结论

---

## 2. Decision

> **本节待 accept 后填写最终选择。**Proposed 阶段先列候选 + 推荐。

### 候选 A：Delegate to installed `x-article-md-paste` extension（推荐）

skill 只负责：检测扩展安装 → 用 Playwright 打开 `https://x.com/compose/articles` → 把 .md 文件原文塞进 `clipboardData`，向编辑器 fire 一次 `paste` 事件。剩下渲染 / 图片上传 / 表格 / 推文嵌入 / 标题封面识别 / 自动保存全部由扩展处理。

### 候选 B：Vendor extension `dist/` into skill

把 `x-article-md-paste` 的编译产物（`content.js` + `main-injector.js` + `styles.css`）vendoring 进 `skills/x-article-upload/vendor/x-article-md-paste/`，运行时通过 Playwright `addInitScript` 注入到 X 页面，自带一份完整实现，不依赖用户装扩展。但要 stub 掉 `chrome.runtime` / `chrome.storage` / license / background 等 MV3 API，并维护与上游扩展 dist 的同步关系。

### 候选 C：维持现状（继续修 api-mode）

把 dirty 的 autosave-hook + render-table 落地，硬攻 `content_state` shape 对齐。**不推荐**——5/13 session 已经在 shape 对齐这一步耗了相当时间没拿下，X 一发版又会再次失配，路径本身的稳定性比"卡 bug"更值得规避。

---

## 3. Options Detail / 对比表

| 维度 | A — Delegate to installed extension | B — Vendor extension dist | C — Continue api-mode (status quo) |
|---|---|---|---|
| **实现复杂度** | ⭐ 最低（~30 LOC：打开 tab + 注入 paste 事件 + 检测扩展） | ⭐⭐⭐ 中（注入 vendored dist + stub MV3 API + 维护同步契约） | ⭐⭐⭐⭐ 高（需要复刻 X autosave / image upload / content_state schema） |
| **稳定性 vs X 改版** | ⭐⭐⭐⭐ 高（X 改版坏的是扩展，修 1 次全员获益） | ⭐⭐⭐⭐ 高（同 A，但要拉新 dist） | ⭐⭐ 低（每次 X 改 GraphQL queryId / features 都要追） |
| **图片 / 表格 / 推文嵌入支持** | ✅ 全有（扩展已实现） | ✅ 全有（同上） | 🚧 部分（autosave / 表格已实现，cover / 推文嵌入还要补） |
| **autosave race** | ✅ 扩展已有 autosave-hook | ✅ 同上 | 🚧 dirty 的 `autosave-hook.mjs` 待落地 |
| **依赖外部状态** | ❌ 要求用户装扩展（开发者用户场景：合理） | ✅ 完全自包含 | ✅ 完全自包含 |
| **跟扩展版本耦合** | ⚪ 行为耦合（扩展行为改了 skill 跟着变） | 🔴 代码耦合（dist 变 vendor 要同步，stub 也可能要更新） | ⚪ 无耦合 |
| **维护成本（年）** | 1 次更新检测逻辑 | 每次扩展 release 同步 dist + 验 stub | 每次 X 改版 + 持续修 bug |
| **复用既有已验证资产** | ⭐⭐⭐⭐ 全量 | ⭐⭐⭐⭐ 全量 | ⭐ 重新发明 |
| **dirty 5+2 files 处置** | 🗑️ 丢弃（沉没成本） | 🗑️ 丢弃（同上） | ✅ 落地 |
| **本仓 `packages/publish` 价值** | 🔄 收敛到 `packages/publish` 暴露 paste-event 注入器 + 检测器 | 🔄 `packages/publish` 暴露 vendored injector | 🔄 继续作为 api-mode 后端 |

---

## 4. Recommendation

**推荐选 A**，理由如下：

1. **最大化复用已经跑通的资产**。`x-article-md-paste` 是 user 主力维护的扩展，autosave hook / Fiber 注入 / 图片管线 / 标题封面识别都已经在 v1.1.x 稳定。skill 端 30 行 LOC 就能站上巨人肩膀。
2. **使用场景天然合理**。这个 skill 的用户是 Claude Code / Codex 用户——开发者群体，装一个 Chrome 扩展是低摩擦动作；加一个"扩展未装"的友好提示 + 一键安装链接，体验完整。
3. **B 看似自包含但是假象**。vendoring extension dist 后，每次扩展 release 都要在 workspace 这边手动同步 `vendor/` + 重新验 stub 是否对得上。同步成本逐月累积，长远比 A 重。
4. **C 已经被 5/13 session 证明痛苦**。`content_state` shape 对齐花的时间已经是放弃 sunk cost 的合理时刻——保留 dirty 文件作为 `experiments/` 参考，但不再投入生产路径。
5. **menu mode 顺手淘汰**。menu mode 是 v1 legacy 路径，A 落地后 menu mode 应该走 deprecation：先标 `--mode=menu` 为 deprecated（console.warn），下一版本删除。

**降级路线**：A 落地后如果扩展真的因任何原因变得"用户装不上"（极小概率），随时可以 fallback 到 B——A 不锁路。

---

## 5. Consequences

如选 **A**：

**Positive**
- skill 代码量大幅缩减；维护人 mental load 降低
- skill ↔ 扩展同步语义靠"行为契约"，比"代码 vendor 契约"轻
- 用户在浏览器里看到的发布过程 = 平时手动 Ctrl+V 看到的，体验一致
- `packages/publish` 内的 paste-event 注入器可以同时给 `apps/vscode` 复用

**Negative / 风险**
- 需要做扩展安装态**检测**：注入前判断 X 页面是否有扩展的注入标记（如 `__xmp_*` 全局变量、特定 DOM 节点 / class、storage event 等）；检测失败要给清晰提示 + 安装链接
- 扩展的运行环境是"用户登录到 X 的浏览器"，skill 通过 Playwright MCP 控制的 tab 必须复用用户 profile（已有逻辑，无变化）
- 文档要写明 "Prerequisites: install x-article-md-paste extension"

**Follow-up Actions**（accept 后建 task）：
1. `packages/publish/src/inject-paste.ts` — 注入器 + 检测器，导出给 skill / vscode 复用
2. skill `upload-article.mjs` 切到新注入器路径；保留 `--mode=menu` 一版本作为兼容并标 deprecated
3. 删除 / 移到 `experiments/`：`scripts/api-mode/` 整个目录 + 2 个 untracked file
4. README 加 prerequisite 段：扩展安装链接 + 检测失败提示
5. 整体迁完后正式删 menu mode（下一 minor 版本）

如选 **B**：

**Positive**
- 完全自包含，用户无须装扩展
- vendoring 后 skill 行为可在 CI 里端到端验证

**Negative / 风险**
- 每次扩展 release 要在 workspace 同步 dist；如果 dist 用了 `chrome.*` 新 API，stub 也要更新
- license / 试用次数 / 商店校验等业务逻辑 vendor 进来后变成噪音，要清干净
- 长期维护成本最高的路线

如选 **C**：

**Positive**
- dirty work 不浪费，autosave-hook + render-table 落地

**Negative**
- `content_state` shape 对齐继续耗时；X 每次改版重打
- 与扩展并行维护两套发布栈，长期分裂

---

## 6. Evidence / References

**Workspace 内：**
- 5 个 dirty 文件：`skills/x-article-upload/scripts/api-mode/{build-content,main,mcp-bridge,parse-md,upload-images}.mjs`
- 2 个 untracked 文件：`skills/x-article-upload/scripts/api-mode/{autosave-hook,render-table}.mjs`
- 入口：`skills/x-article-upload/scripts/upload-article.mjs:88-94`（`--mode=api|menu` 分发）
- 相关 commit：
  - `c1cd97c feat(skill): add --mode=api to upload-article.mjs`
  - `f39f2f3 spike: pure-API X article upload (bb-browser exploration)`
  - `394063a fix(publish): menu mode marker cleanup via React fiber + post-publish autosave nudge`
  - `a184b87 fix: locale-resilient create-button finder (skill + publish package)`

**姊妹仓（已验证的 Fiber 注入 + autosave hook）：**
- `G:\Projects\0Tools\x-article-md-paste`
- 关键 commits：`ad1192d feat: hook real autosave XHR/fetch instead of guessing with timers`、`9a6c788 fix: replace fixed sleeps with autosave-settled detection`
- 当前生产版本 v1.1.1 paste/drop URL guard + SPA matches 已验证稳定

**Session 历史：**
- `C:\Users\16831\.claude\projects\G--Projects-0Tools-x-article-workspace\be04ee58-a47f-4b7c-8ad6-ee66b5181b55.jsonl` 2026-05-13
- 关键 turn：29（mode 现状）、155-161（Decision #1）、165（plugin commits 引用）、244-326（content_state shape 对齐失败）、350-361（Decision #2 + 用户 interrupt）

---

## 7. Decision Log

| 时间 | 人 | 动作 |
|---|---|---|
| 2026-05-15 | @Coder | Drafted (Proposed) |
| pending | @冷酷小猫 | Accept / Reject / Request changes |
