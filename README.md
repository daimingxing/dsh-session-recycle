# dsh-session-trash · 会话回收站

**DeepSeek Harness (DSH) 的会话回收站插件。**

侧边栏会话「⋯」菜单一键把会话（含全部子会话）移入回收站；回收站里可查看、还原或彻底删除。删除是**移动**而不是标记：`$DSH_HOME/sessions`、`workspace.json`、`session_projcache` 三处不留任何残留。

[English](#english) | 中文

---

## ✨ 功能特性

- **侧边栏菜单「删除会话」**（红字，菜单最底部）——把会话与其整棵子会话树一起移入回收站，删除后 3 秒内可在浮层里一键撤销。
- **移动语义**——删除时日志目录原样移入 `$DSH_HOME/dsh-session-trash/sessions/<id>/`，DSH 自己的存储里不留文件、不留 ID：
  - `~/.dsh/sessions/<项目>/<会话>/`（日志）→ 移入回收站
  - `~/.dsh/storages/session_projcache/sessions/<id>.json`（投影缓存）→ 清除
  - `~/.dsh/storages/workspace.json`（工作区记账、归档集、置顶集）→ 通过 registry 公开 API 摘除
- **回收站管理**（设置 → 会话回收站）——每个条目三个按钮：
  - **查看会话**：只读预览（折叠末尾 60 条表层消息，user / assistant / tool）。
  - **还原会话**：日志目录原路移回，重新挂回工作区，侧边栏立即恢复；删除前已归档的还原后仍是已归档（「已删除」与「已归档」独立共存）。
  - **彻底删除**：物理清除回收站里的日志与全部残留，两步确认，不可恢复。
- **运行中保护**——目标树里任何一个会话（含子会话）有运行中的 agent，整个请求被拒绝并点名。
- **已加载会话的延迟收尾**——刚打开过的会话持有日志写句柄（Windows 无法移动被占用的目录），这类成员的物理移动延迟到会话关闭（`agent/disposed`）或下次启动巡检时自动完成；期间列表过滤层保证它不可见。
- **列表隔离**——在本插件 fiber 上包一层 `sessionQuery.listSessions`，回收站里的会话在侧边栏与搜索的任何档位都不可见；插件停用即恢复，数据无损。
- **浅色/深色自适应**——全部颜色引用宿主主题 token（`--dsw-alias-*`），文案走宿主 locale 服务（中/英）。

## 📦 安装

```bash
dsh plugin --profile <name> add link:/绝对路径/dsh-session-trash
# 或打包发布后：
dsh plugin --profile <name> add dsh-session-trash
```

要求 DSH 0.2.1-rc.1 及以上。

## 🚀 使用

1. 侧边栏任意会话行 →「⋯」→ 最底部红字「**删除会话**」。
2. 弹出「已移入回收站」浮层，3 秒内点「撤销」可反悔。
3. 打开 **设置 → 会话回收站** 管理条目（查看 / 还原 / 彻底删除）。

## 🔌 工作原理

- **单包 bundle**：host 半边由 `cordis.patch.yml` 挂载；浏览器半边经 `dsh.client` + `exports["./client"]` 进入模块图。
- 浏览器通过插件自身的 `/session-trash/api/*` HTTP 路由与宿主通信（`ctx.webServer.register`；浏览器认证复用 `ctx.connection.requestRejection`）。
- 唯一的宿主方法补丁是 `sessionQuery.listSessions` 的可撤销过滤层；删除/还原/彻底删除全部走 `sessionPersistence.findLog` / `stat`、`workspaceRegistry` 公开 API 与确定的磁盘路径规则（`projectKey` / `encodeSegment`，与 `dsh-session-persistence-jsonl` 一致，`test/parity.test.mjs` 对真实日志逐字节验证）。
- 回收站索引是 `$DSH_HOME/dsh-session-trash/index.json`（原子写：临时文件 + rename），行内记录每个成员的原始路径（`fromDir`），还原按精确原路移回。

## ⚠️ 已知边界

- 附件是全局内容寻址存储（`~/.dsh/attachments/`），不随会话删除；v1 不清理。
- 部署若启用 sqlite 全文索引（默认 `:memory:` + `openAt: never`，未启用），索引清理不在 v1 范围。
- 删除时工作区记账槽位被移除：还原后会话回到该工作区列表顶部（不是原位置）。
- 已加载会话的日志要等会话关闭后才真正移入回收站目录；在那之前「彻底删除」会提示 `SESSION_LOADED`，关闭对应窗口或重启 DSH 后重试。

## 🧪 测试

```bash
node test/parity.test.mjs
```

（对真实会话日志验证路径编码一致性与多帧 zstd 解码；无破坏性操作。）

## 📄 许可证

[MIT](LICENSE)

---

<a id="english"></a>
## English

**Session trash for DeepSeek Harness.**

Delete a session (with its whole subagent tree) from the sidebar "⋯" menu into a recycle bin; view, restore, or permanently delete it from Settings → Session Trash. Deletion is a **move**: no residue is left in `$DSH_HOME/sessions`, `workspace.json`, or `session_projcache`. Running sessions are protected; a 3-second undo toast follows every delete. Sessions that are merely loaded (write handle open) hide immediately and are physically moved when their agent disposes or at the next startup sweep.

Install with `dsh plugin --profile <name> add link:/absolute/path/dsh-session-trash` (DSH >= 0.2.1-rc.1). The only host-method patch is a revocable `sessionQuery.listSessions` filter; all mutations go through `sessionPersistence`, `workspaceRegistry` public APIs and the deterministic on-disk path rules verified byte-for-byte by `test/parity.test.mjs`.

Known limits: content-addressed attachments are not removed; sqlite full-text index cleanup is out of scope for v1 (disabled by default); restoring re-attaches the session at the top of its workspace list, not its previous position; permanently deleting a still-loaded session reports `SESSION_LOADED` until its windows close or DSH restarts.

License: MIT.
