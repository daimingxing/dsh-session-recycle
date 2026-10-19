<div align="center">

<img src="./icon.svg" alt="会话回收站图标" width="72" height="72">

# 会话回收站

**给 DeepSeek Harness 补上删除，让清理会话也能反悔。**

`dsh-session-recycle`

3 秒撤销 · 随时还原 · 子会话一起整理 · 零 npm 依赖

</div>

---

DSH 的归档会保留磁盘日志。会话回收站提供真正的清理入口：先把不需要的会话放进回收站，确认不再需要时，再彻底删除。

## ✨ 有哪些亮点

| 功能 | 你可以做什么 |
| :--- | :--- |
| 🗑️ 删除可反悔 | 从侧边栏删除会话，连同全部 subagent 子会话一起整理；3 秒内一键撤销 |
| ↩️ 查看与还原 | 在回收站预览最近内容，随时还原；标题和原有归档状态一并恢复 |
| 🛡️ 安心清理 | 运行中的会话拒绝删除；已打开但空闲的会话可直接处理 |
| 👻 找回隐藏残留 | 扫描空白会话、失去父会话的子会话和登记残留，集中清理 |

> **先收纳，再清除。** 普通删除只更新回收站索引与工作区记录，日志留在原处；只有「彻底删除」才物理清除日志、释放空间。

## 📦 安装

适用于 **DSH 0.2.1-rc.1 及以上的 0.2.x 版本**。将 `<name>` 替换为你的 profile 名称：

**从 npm 安装**（包发布到 npm 后可用；DSH 会安装并注册插件）：

```bash
dsh plugin --profile <name> add dsh-session-recycle@latest
```

**从本地 npm 包安装**（适合发布前试用或离线分发；替换为实际文件路径）：

```bash
dsh plugin --profile <name> add "D:/Downloads/dsh-session-recycle-0.2.0.tgz"
```

## 🚀 三步上手

1. **整理侧边栏** — 打开会话的「⋯」菜单，点击红色删除项；误删时点提示中的撤销。
2. **管理回收站** — 进入「设置 → 会话回收站」，查看内容、还原会话，或确认后彻底删除。
3. **清理隐藏残留** — 在回收站运行幽灵会话扫描，检查结果后清理不再需要的记录。

## 使用须知

- **彻底删除不可撤销。** 删除前会校验日志目录；遇到未知文件会拒绝操作，避免误删。
- 回收站状态由插件索引维护；卸载插件或丢失索引后，原位保留的会话可能重新出现。
- 保护范围是当前 DSH 进程；清理时避免在另一个实例中同时操作相同会话。
- 全局附件存储与 SQLite 全文索引不在清理范围；还原后的会话回到工作区列表顶部。

<details>
<summary><strong>开发与测试</strong></summary>

运行时代码只有 [index.js](./index.js) 和 [client.js](./client.js)，无 npm 依赖、无周期轮询。

本地安装：

```bash
dsh plugin --profile <name> add link:/绝对路径/dsh-session-recycle
```

```bash
node --test test/operations.test.mjs
node test/parity.test.mjs
```

`operations` 使用临时会话数据，通过插件 HTTP 入口验证删除、还原、彻底删除和并发保护；`parity` 抽样本机 DSH 日志，验证目录编码、文件白名单与多帧解压。

打包（在项目根目录执行，无需构建或安装依赖）：

```bash
npm pack --dry-run
npm pack
```

生成 `dsh-session-recycle-0.2.0.tgz`。发布到 npm 时，先用 `npm login` 登录发布账号，再执行 `npm publish --access public`；发布前请先用本地包安装验证。

</details>

<details>
<summary><strong>English · Session Recycle Bin</strong></summary>

A recycle bin for **DeepSeek Harness**. Delete sessions with their subagent trees, undo within 3 seconds, preview or restore them later, and permanently delete logs when you are ready. Running sessions are protected. A ghost scan helps clean up blank sessions, orphaned subagents, and stale records.

Soft deletion leaves logs in place. Only permanent deletion removes them from disk; global attachments and the SQLite full-text index are outside its scope. Protection applies to the current DSH process. Uninstalling the plugin or losing its index may make retained sessions reappear.

Requires **DSH >= 0.2.1-rc.1, < 0.3.0**. Use the installation command above, then open **Settings → Session Trash**. Zero npm dependencies.

</details>

---

[MIT License](./LICENSE)
