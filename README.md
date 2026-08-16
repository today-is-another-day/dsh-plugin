# dsh-deepseek-balance

DSH Web GUI 插件：在对话输入区**模型选择器左侧**实时显示 DeepSeek 账户余额徽标（如 `70.79元`）。

- 仅当当前选中的是 **DeepSeek 系列模型**（模型名含 `DeepSeek`/`deepseek`）时显示，切换到其他供应商的模型自动隐藏。
- **每 10 秒**自动刷新；点击徽标立即强制刷新。
- 悬停 tooltip 显示余额拆分（充值/赠送）、`is_available` 状态与更新时间。
- **零配置**：复用 DSH 自身的 `DEEPSEEK_API_KEY`（`deepseek-official` provider 的凭据链：进程环境 / 调用目录 `.env` / `~/.dsh/.env` / `~/.dsh/.credentials.yaml`），与模型调用共用同一把 Key。
- 密钥不出现在任何 HTTP 响应、日志或界面文本中；余额路由带 loopback 信任围栏（与 dsh-ssh 路由同款）。

## 数据源

`GET https://api.deepseek.com/user/balance`（[官方文档](https://api-docs.deepseek.com/zh-cn/api/get-user-balance/)），返回 `balance_infos`（多币种时优先 CNY）与 `is_available`。DeepSeek 官方不提供 Key 级用量/明细接口，本插件只展示余额。

## 安装（本地开发版）

```bash
pnpm install && pnpm build
dsh plugin --profile web add link:/Users/wxy/projects/my/projects/dsh-plugin
# 重启 dsh web（插件集变更在重启后生效）
```

## 开发

```bash
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest
pnpm build       # tsc 声明 + tsdown 双面打包（lib/index.js 宿主半 / lib/client.js 浏览器半）
pnpm watch       # tsdown --watch
```

结构：`src/{index,routes,engine,protocol}.ts` 为宿主半（cordis 插件 + 唯一路由）；`src/client/` 为浏览器半（badge 注入 + 自愈 + 轮询）。锚点候选选择器（按序取首个命中）：`[data-composer-seat="model"]` → `[data-composer-seat="input.model"]` → `[data-composer-seat="conversation.input.model"]` → `[data-composer-seat*="model"]`，徽标作为该座位元素的前一个兄弟节点插入（视觉上位于模型选择器左侧）。

## 限制与假设

- 可见性按**模型名文本**匹配 `/deepseek/i`；若模型名不含 DeepSeek 字样但实际走 `deepseek-official` provider，徽标不会显示（v1 假设）。
- 默认读取 `DEEPSEEK_API_KEY`（dsh-llm-deepseek 的默认 `apiKeyEnv`）；如自定义过该配置项需改同名环境变量。
- 上游调用量约 6 次/分钟（10s 轮询 + 宿主 10s TTL 缓存 + 在途合并）。

## 路线图（不在 v1 范围）

- OpenAI / Anthropic / Gemini 等多家供应商（Gemini 官方无 Key 级计费接口）。
- 独立面板页、用量明细图表、agent 工具（`usage_report` 等）。
- DeepSeek 平台会话级用量（需登录 token）。
