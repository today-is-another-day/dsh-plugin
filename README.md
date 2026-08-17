# dsh-plugin

DSH Web GUI 插件全家桶仓库（monorepo），每个插件位于 `packages/` 下独立维护。

## 插件列表

| 包 | 说明 |
| --- | --- |
| [packages/dsh-deepseek-balance](packages/dsh-deepseek-balance) | DeepSeek 账户余额徽标（模型选择器左侧显示） |
| [packages/dsh-archived-sessions-sidebar](packages/dsh-archived-sessions-sidebar) | 左侧边栏「已归档会话」区域（查看 / 打开 / 取消归档 / 删除） |

## 常用命令

```bash
pnpm install      # 安装全部依赖
pnpm -r build     # 构建所有插件
pnpm -r test      # 运行所有插件测试
pnpm -r typecheck # 类型检查
```

## 安装插件到 DSH

以 `link:` 方式挂载到 web profile（示例）：

```bash
dsh plugin --profile web add link:/Users/wxy/projects/my/projects/dsh-plugin/packages/dsh-deepseek-balance
dsh plugin --profile web add link:/Users/wxy/projects/my/projects/dsh-plugin/packages/dsh-archived-sessions-sidebar
```

## Git 历史

- `dsh-deepseek-balance`：原独立仓库 `today-is-another-day/dsh-deepseek-balance`（已归档）
- `dsh-archived-sessions-sidebar`：原独立仓库 `today-is-another-day/dsh-archived-sessions-sidebar`（已归档），历史经 `git subtree` 并入
