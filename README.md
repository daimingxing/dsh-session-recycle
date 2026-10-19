# 🗑️ dsh-session-trash · 会话回收站

**DeepSeek Harness (DSH) 的会话回收站插件。**

[English](#english) | 中文

把会话（含全部子会话）从侧边栏删进回收站，随时查看、还原或彻底删除。删除是**移动**：`sessions/`、`workspace.json`、`session_projcache` 三处零残留。

## ✨ 功能

**🗑️ 删除** —— 会话行「⋯」菜单最底部的红字入口。行立即从侧边栏消失（广播宿主自带事件，不掉进「未分组」），3 秒内可撤销。

**♻️ 回收站**（设置 → 会话回收站）—— 每条三个操作：

| 操作 | 行为 |
|---|---|
| 👁️ 查看会话 | 只读预览末尾 60 条消息 |
| ↩️ 还原会话 | 原路移回、重新挂回工作区，标题立即恢复；删除前已归档的仍是已归档 |
| 🔥 彻底删除 | 物理清除全部痕迹，两步确认 |

**👻 幽灵会话扫描** —— 磁盘有痕迹、两边都不可见的会话，按不可见原因分三类：

| 类别 | 含义 |
|---|---|
| 🫥 空白会话 | 0 条消息的空壳（blank 过滤永不显示） |
| 🪃 孤儿会话 | 有内容但无归属：无记账，或父会话已删的 subagent |
| 🏷️ 登记残留 | `workspace.json` / 投影缓存挂着 id，日志已不在 |

**🛡️ 保护与隔离** —— 运行中的会话拒绝删除（点名）；回收站里的会话在侧边栏与搜索任何档位都不可见；插件停用即恢复，数据无损。

## 📦 安装

```bash
dsh plugin --profile <name> add dsh-session-trash
# 本地开发：
dsh plugin --profile <name> add link:/绝对路径/dsh-session-trash
```

要求 DSH 0.2.1-rc.1 及以上。

## ⚠️ 已知边界

- **已加载会话需要一次重启收尾**：agent 在会话打开期间常驻（进程内不释放），其日志无法立即移动/删除。删除立即生效（列表消失），物理收尾由下次 DSH 启动自动完成，回收站行以「待收尾」/「待物理清除」徽标注明。
- 还原后会话回到工作区列表顶部，不是原位置。
- 附件（全局内容寻址存储）与 sqlite 全文索引（默认未启用）不在清理范围。
- 设置导航图标按文案匹配自己的行；与其他插件文案完全相同时可能错标（仅影响图标）。

## 🔌 工作原理

单包双半边 bundle：host 由 `cordis.patch.yml` 挂载，browser 经 `dsh.client` 进入模块图；两端通过 `/session-trash/api/*` 通信（浏览器认证复用 `ctx.connection`）。

唯一的宿主方法补丁是 `sessionQuery.listSessions` 的可撤销过滤层。删除/还原/彻底删除全部走 `sessionPersistence`、`workspaceRegistry` 公开 API 与确定的磁盘路径规则（与 `dsh-session-persistence-jsonl` 的 `projectKey`/`encodeSegment` 逐字节一致，`test/parity.test.mjs` 对真实日志验证）。回收站索引在 `$DSH_HOME/dsh-session-trash/index.json`（原子写），记录每个成员的原始路径，还原精确原路移回。

🪶 **零依赖**：两个源文件，无 npm 依赖、无图标库（图标为手写内联 SVG / CSS mask）。

## 🧪 测试

```bash
node test/parity.test.mjs
```

## 📄 许可证

[MIT](LICENSE)

---

<a id="english"></a>
## 🗑️ English

**Session trash for DeepSeek Harness.**

Move sessions (with their whole subagent tree) from the sidebar into a recycle bin; view, restore, or permanently delete them, and scan for invisible leftovers. Deletion is a **move**: zero residue in `sessions/`, `workspace.json`, and `session_projcache`.

## ✨ Features

**🗑️ Delete** — red entry at the bottom of the session-row "⋯" menu. The row leaves the sidebar instantly (stock host broadcast, no "Ungrouped" fallthrough); 3-second undo toast.

**♻️ Trash** (Settings → Session Trash) — three actions per entry:

| Action | Behavior |
|---|---|
| 👁️ View | Read-only preview of the last 60 messages |
| ↩️ Restore | Moves logs back to their exact original paths, re-attaches accounting; title shows immediately, archived-before stays archived |
| 🔥 Permanent delete | Purges every trace, double-confirm |

**👻 Ghost scan** — sessions on disk but invisible on both sides, grouped by reason:

| Kind | Meaning |
|---|---|
| 🫥 Blank | 0-message shells (never shown by the blank filter) |
| 🪃 Orphan | Content but unaccounted, or a subagent whose parent was deleted |
| 🏷️ Registry residue | Ids in `workspace.json`/projection cache with no log |

**🛡️ Safety** — running sessions refuse deletion by name; trashed sessions are hidden from sidebar and search in every filter mode; disabling the plugin restores everything untouched.

## 📦 Install

```bash
dsh plugin --profile <name> add dsh-session-trash
```

DSH >= 0.2.1-rc.1.

## ⚠️ Known limits

- **A still-loaded session needs one DSH restart to finish physically** — agents stay resident in-process; the trash row shows a pending badge and the startup sweep finishes automatically.
- Restore places the session at the top of its workspace list, not its previous position.
- Attachments and the (disabled-by-default) sqlite index are out of scope.
- The settings-nav icon matches its row by label text; a plugin with the exact same label could mis-mark it (cosmetic only).

## 🔌 How it works

The only host-method patch is a revocable `sessionQuery.listSessions` filter; everything else goes through public `sessionPersistence`/`workspaceRegistry` APIs and deterministic path rules verified byte-for-byte by `test/parity.test.mjs`. Trash index lives at `$DSH_HOME/dsh-session-trash/index.json` (atomic writes) and records each member's original path for exact restores.

🪶 **Zero dependencies**: two source files, no npm packages, hand-written inline icons.

## 🧪 Test

```bash
node test/parity.test.mjs
```

## 📄 License

[MIT](LICENSE)
