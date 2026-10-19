# ♻️ dsh-session-recycle · 会话回收站

**DeepSeek Harness (DSH) 的会话回收站插件。**

[English](#english) | 中文

把会话（含全部子会话）从侧边栏删进回收站，随时查看、还原或彻底删除。删除是**索引软删除**：回收站阶段日志原地不动、零磁盘改动；只有「彻底删除」才物理清除，且经多重硬化校验。

## ✨ 功能

**🗑️ 删除** —— 会话行「⋯」菜单最底部的红字入口。行立即从侧边栏消失（广播宿主自带事件，不掉进「未分组」），3 秒内可撤销。已打开的空闲会话也能直接删除（运行时护栏先释放它）。

**♻️ 回收站**（设置 → 会话回收站）—— 每条三个操作：

| 操作 | 行为 |
|---|---|
| 👁️ 查看会话 | 只读预览末尾 60 条消息 |
| ↩️ 还原会话 | 重新挂回工作区，标题立即恢复；删除前已归档的仍是已归档 |
| 🔥 彻底删除 | 硬化校验后物理清除全部痕迹，两步确认 |

**👻 幽灵会话扫描** —— 磁盘有痕迹、两边都不可见的会话，按不可见原因分三类：

| 类别 | 含义 |
|---|---|
| 🫥 空白会话 | 0 条消息的空壳（blank 过滤永不显示） |
| 🪃 孤儿会话 | 有内容但无归属：无记账，或父会话已删的 subagent |
| 🏷️ 登记残留 | `workspace.json` / 投影缓存挂着 id，日志已不在 |

**🛡️ 保护** —— 运行中的会话拒绝删除（点名）；回收站里的会话被运行时护栏阻止重新加载，从侧边栏与搜索任何档位都不可见。彻底删除失败有明确报错提示（浮层置于设置对话框之上），失败不产生半清空状态——标题缓存等可逆痕迹保留，还原后不丢标题。

## 📦 安装

```bash
dsh plugin --profile <name> add dsh-session-recycle
# 本地开发：
dsh plugin --profile <name> add link:/绝对路径/dsh-session-recycle
```

要求 DSH 0.2.1-rc.1 及以上。

## ⚠️ 已知限制

- **回收站期间日志仍在 `sessions/` 原位**：不认识本插件索引的其他客户端（另一个不装插件的 DSH profile、冷会话列表）仍会列出这些会话；彻底删除后才真正消失。
- **卸载插件或索引损坏时行会复活**：软删除的「已删除」状态由索引维持，索引没了就等于没删过。索引损坏时插件会把它备份成 `.corrupt-*` 再按空索引继续。
- **跨进程写入拦不住**：运行时护栏只覆盖本进程；另一个 DSH 实例打开同一会话继续写日志时，本插件无法感知（不引入跨进程文件锁）。
- **purge 宁可拒绝也不删错**：日志目录里出现白名单之外的文件（DSH 新版本引入的新文件形态）时彻底删除会报错拒绝，直到插件更新白名单。这是刻意设计。会话 id 形态支持主会话 `session-<uuid>` 与 subagent 子会话裸 `<uuid>` 两种；目录已不在的成员按已清除处理，重复彻底删除可收敛。
- 还原后会话回到工作区列表顶部，不是原位置。
- 附件（全局内容寻址存储）与 sqlite 全文索引（默认未启用）不在清理范围。
- 设置导航图标按文案匹配自己的行；与其他插件文案完全相同时可能错标（仅影响图标）。

## 🔌 工作原理

单包双半边 bundle：host 由 `cordis.patch.yml` 挂载，browser 经 `dsh.client` 进入模块图；两端通过 `/session-trash/api/*` 通信（浏览器认证复用 `ctx.connection`）。

**三层操作，风险递增：**

1. **删除（无磁盘改动）**：写回收站索引（`$DSH_HOME/dsh-session-recycle/index.json`，原子写）→ 摘除 workspace 记账 → 广播宿主 `api-session/removed`。日志、投影缓存记录全部原地不动。
2. **还原（无磁盘改动）**：删索引行 → 重新挂账 → 推送 `api-session/added`（`coldSnapshot` 重放折叠标题）。
3. **彻底删除（唯一物理路径）**：先运行时护栏 `dispose()` 已加载的空闲 agent 释放写句柄，再对日志目录执行硬化删除——UUID 形态校验、目录名必须等于 `encodeSegment(id)`（路径只能从 id 推导，绝不接受传入路径）、realpath 必须在 sessions 根内、逐层 symlink 检查、**内容白名单**（只放行 JSONL 后端的已知文件形态，陌生文件即整体拒绝）、逐文件 `unlink` + 非递归 `rmdir`。

**运行时护栏**：wrap `agents.create/resume`，在 factory 边界截获 `{ agent, dispose }` 句柄（UI 打开会话时上游丢弃该句柄，wrap 是唯一获取点）。用于：删除/还原前主动释放已加载的空闲会话；回收站 id 进阻止集合，禁止被重新加载。宿主升级导致 wrap 失效时自动降级——删除退回「拒绝已加载会话」，其余功能不受影响。

宿主方法补丁只有 `sessionQuery.listSessions` 的可撤销过滤层。目录名规则与 `dsh-session-persistence-jsonl` 逐字节一致（`test/parity.test.mjs` 对真实日志验证）。

🪶 **零依赖**：两个源文件，无 npm 依赖、无图标库（图标为手写内联 SVG / CSS mask）。

## 🧪 测试

```bash
node --test test/operations.test.mjs
node test/parity.test.mjs
```

`operations` 通过实际插件 HTTP 入口和临时会话夹具验证删除、还原、彻底删除及并发保护，不依赖本机会话。`parity` 额外抽样本机真实日志验证目录编码、白名单和多帧解压。

## 📄 许可证

[MIT](LICENSE)

---

<a id="english"></a>
## ♻️ English

**Session trash for DeepSeek Harness.**

Move sessions (with their whole subagent tree) from the sidebar into a recycle bin; view, restore, or permanently delete them. Deletion is an **index-based soft delete**: the recycle stage touches nothing on disk; only permanent delete purges files, behind hardened checks.

## ✨ Features

**🗑️ Delete** — red entry at the bottom of the session-row "⋯" menu. The row leaves the sidebar instantly (stock host broadcast, no "Ungrouped" fallthrough); 3-second undo toast. Even an open-but-idle session deletes right away (the runtime guard releases it first).

**♻️ Trash** (Settings → Session Trash) — three actions per entry:

| Action | Behavior |
|---|---|
| 👁️ View | Read-only preview of the last 60 messages |
| ↩️ Restore | Re-attaches accounting; title shows immediately, archived-before stays archived |
| 🔴 Permanent delete | Physically purges every trace behind hardened checks, double-confirm |

**👻 Ghost scan** — sessions on disk but invisible on both sides, grouped by reason:

| Kind | Meaning |
|---|---|
| 🫥 Blank | 0-message shells (never shown by the blank filter) |
| 🪃 Orphan | Content but unaccounted, or a subagent whose parent was deleted |
| 🏷️ Registry residue | Ids in `workspace.json`/projection cache with no log |

**🛡️ Safety** — running sessions refuse deletion by name; trashed sessions are blocked from reloading by the runtime guard and hidden from sidebar and search in every filter mode.

## 📦 Install

```bash
dsh plugin --profile <name> add dsh-session-recycle
```

DSH >= 0.2.1-rc.1.

## ⚠️ Known limits

- **Trashed logs stay in `sessions/` until permanent delete**: clients unaware of this plugin's index (another DSH profile without the plugin, cold-session listings) still list them.
- **Uninstalling or a corrupted index revives the rows**: the soft-deleted state is maintained by the index; a corrupted index is backed up as `.corrupt-*` and treated as empty.
- **Cross-process writes are not detected**: the runtime guard covers this process only.
- **Purge refuses rather than deletes wrong**: unknown file shapes in a log directory (e.g. introduced by a future DSH version) make permanent delete fail closed until the whitelist is updated. By design.
- Restore places the session at the top of its workspace list, not its previous position.
- Attachments and the (disabled-by-default) sqlite index are out of scope.
- The settings-nav icon matches its row by label text; a plugin with the exact same label could mis-mark it (cosmetic only).

## 🔌 How it works

One bundle, two halves: host mounted via `cordis.patch.yml`, browser via `dsh.client`; they talk over `/session-trash/api/*` (browser auth reuses `ctx.connection`).

**Three tiers of operation, escalating risk:**

1. **Delete (no disk writes)**: append to the trash index (`$DSH_HOME/dsh-session-recycle/index.json`, atomic) → detach workspace accounting → broadcast the stock `api-session/removed`. Logs and projection-cache records stay put.
2. **Restore (no disk writes)**: drop the index row → re-attach accounting → push `api-session/added` (title folded via `coldSnapshot`).
3. **Permanent delete (the only physical path)**: the runtime guard `dispose()`s loaded idle agents and detaches the host sessions-store entry to release write handles, then hardens before unlinking: id shape check (`session-<uuid>` for main sessions, bare `<uuid>` for subagent children), directory name must equal `encodeSegment(id)` (paths are derived, never accepted), realpath must resolve inside the sessions root (a missing directory counts as already purged), per-level symlink checks, a **content whitelist** (only known JSONL-backend file shapes; anything unknown refuses the whole purge), per-file `unlink` + non-recursive `rmdir`. Failures surface as visible toasts and never leave a half-cleaned state — reversible traces (including the cached title) survive a failed purge, so restores keep their titles.

**Runtime guard**: wraps `agents.create/resume` to capture the `{ agent, dispose }` handle at the factory boundary (the UI path drops it; the wrap is the only way to obtain it). Used to release loaded idle sessions before delete/restore and to block reloads of trashed ids. If a DSH upgrade breaks the wrap, it degrades automatically — delete falls back to refusing loaded sessions, everything else keeps working.

The only host-method patch is a revocable `sessionQuery.listSessions` filter. Directory-name rules verified byte-for-byte by `test/parity.test.mjs`.

🪶 **Zero dependencies**: two source files, no npm packages, hand-written inline icons.

## 🧪 Test

```bash
node --test test/operations.test.mjs
node test/parity.test.mjs
```

## 📄 License

[MIT](LICENSE)
