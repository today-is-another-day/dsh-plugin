# dsh-archived-sessions-sidebar

A DSH Web plugin: an **Archived Sessions** area directly in the left sidebar, below the workspace region — browse, open, unarchive, and delete archived conversations, with independent collapse for both the workspace region and the archived section.

一个 DSH Web 插件：在左侧边栏**工作区区域下方**提供「已归档会话」区域 —— 查看、打开、取消归档与删除已归档会话；工作区与已归档会话两个区域各自支持折叠收起，折叠状态本地持久化。

## Features（功能）

- **侧边栏「已归档会话」区域**：位于工作区浏览区域与设置区之间，列出会话（标题 + 相对时间），数量徽标实时更新
- **按工作区分组**：归档会话按其所属工作区分组显示（组头 = 工作区标题 + 会话数，按工作区注册顺序），无工作区归属的会话落入末尾的「未分组」桶；无任何工作区时退化为平铺列表
- **分组可折叠**：点击组头即可独立折叠/展开该工作区下的会话行（chevron 旋转 + 行隐藏），各分组折叠状态同样持久化；与整个区域、工作区区域的折叠互不干扰
- **行操作**（悬停显示）：
  - **打开**：先取消归档再打开会话，保证刷新后会话仍留在工作区
  - **取消归档**：恢复到原工作区位置（归档不删除 accounting 槽位，位置自动还原）
  - **删除**：带确认弹窗，永久移除会话记录（工作区 accounting、归档集合条目与持久化产物一并清理）；运行中会话拒绝删除并提示
- **双区域折叠**：工作区区域（chevron 注入工作区 section header 最右端）与已归档区域（自有 chevron）各自独立折叠/展开，状态存 `localStorage`（键 `dsh.archivedSidebar.v1`），刷新后保持；折叠时工作区区域真实收缩（仅剩标题行），已归档区域上移
- **边栏 rail 模式**：侧边栏收起为窄栏时，区域退化为图标行
- **空态与降级**：无归档会话时显示占位文案；会话已被外部删除时行操作返回 404 并给出友好提示；标题缺失时降级为会话 ID 短码
- **中英双语**：按页面语言自动选择文案
- **agent 协作播报**：host 半注册 `systemPrompt` 章节，agent 会话自动知晓本插件能力

## How it works（原理）

- **归档集合**：读取官方 workspace 域的 `archivedSessionIds`（客户端 `ctx.workspaces.list` 实时订阅；host 侧 `workspaceRegistry`）。
- **取消归档**：官方 rc.6 只提供 `archiveSession`、无取消归档 API。本插件使用官方公开原语 `workspaceRegistry.requireState()` + `setState()`（与官方 `archiveSession` 同源）读写归档集合，运行在插件自己的串行变更队列中，避免并发丢失更新。任何写入都会触发核心的 `host/archived-sessions-changed` 帧，客户端实时刷新；每次变更后客户端再调用 `workspaces.refresh()` 兜底自愈。
- **删除**：`sessionPersistence.remove` 存在则用之；否则经 `locate()` 定位记录目录并 `rm`，且**目录必须严格位于 `$DSH_HOME/sessions` 根内**，否则拒绝删除。
- **安全围栏**：`/archived-sidebar/api/*` 仅信任本机回环请求（127.0.0.1 / localhost / ::1）与同源标记；用 `--host 0.0.0.0` 或局域网地址启动时 API 全部返回 403，区域显示「不可用」提示。
- **零核心修改**：只使用官方公开服务（`webServer`、`workspaceRegistry`、`sessionPersistence`、`sessions`、`agents`），不修改任何 DSH 核心包源码。

## Compatibility notes（兼容性说明）

- **并发窗口**：插件队列与核心 `archiveSession` 内部队列是两套队列，同一毫秒内的归档/取消归档交错仍可能丢失一次更新；客户端刷新与 `refresh()` 自愈（与官方取消归档能力的限制一致）。
- **删除当前会话**：DSH host 端没有公开的「当前会话」API，本机进程若直接调用 API 仍可删除当前打开的会话（与官方删除接口行为一致）；运行中会话的 409 保护仍然生效。
- **删除不级联**：只删除所选会话本身；子代理会话、分叉与产出文件保留。
- 兼容 DSH `0.1.0-rc.6` 的公开面；`agentLoop` 缺失时删除自动降级为 best-effort 路径。

## Development（开发）

```sh
pnpm install
pnpm build      # host → lib/index.js；client → lib/client.js（含 __ModuleLoader__ 包装）
pnpm typecheck
pnpm test       # vitest（host 路由 / 围栏 / 删除路径 + client 控制器 / DOM）
pnpm watch      # esbuild watch 双入口
```

Layout: `src/host/`（Node 半）、`src/client/`（浏览器半，纯 TS + DOM，无 React）、`tests/`。

## Install（安装到 web profile）

```sh
dsh plugin --profile web add link:/path/to/dsh-archived-sessions-sidebar
```

然后在 `~/.dsh/profiles/web/cordis.patch.yml` 追加：

```yaml
- insert:
    - id: dsh-archived-sessions-sidebar
      name: 'dsh-archived-sessions-sidebar'
```

重启 `dsh web` 并刷新页面，侧边栏即出现「已归档会话」区域。

## License

MIT
