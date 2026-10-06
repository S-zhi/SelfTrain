# GitHub Issue 自动化

仓库提供三条 GitHub Actions 工作流：

- **State control**：新 Issue 自动进入 `state:needs-triage`。当前阶段的 `action:agent` 或 `action:human` 被移除后，工作流会推进到下一阶段并请求一次评审。
- **Action control**：新增 `state:*` 标签时，请求评审并分配 `action:agent` 或 `action:human`。
- **Sync labels**：手动同步 `.github/label.yaml` 中声明的标签。它只更新配置列出的标签，仓库里的其他标签会保留。

正常阶段按 `needs-triage → assess-plan → coding → code-review → wait-auto-merge` 推进。`state:agent-failed` 用于暂停失败或取消的任务；修复问题并决定如何继续后，由维护者移除此暂停标签并设置合适的阶段标签。最后阶段只等待关联 PR **实际合并**，不会自动合并 PR 或关闭 Issue。

## 启用

1. 确保仓库启用了 GitHub Actions。
2. 在仓库 **Settings → Secrets and variables → Actions** 添加 `TYPESAFE_API_KEY`。
3. 将这些文件合入默认分支后，在 **Actions → Sync labels → Run workflow** 手动运行一次，并确认 `state:*` 与 `action:*` 标签已创建。
4. 新建一个测试 Issue，确认它进入 `state:needs-triage` 并得到一个 action 标签。

每次评审会把 Issue 标题、描述、评论、标签、当前阶段和 `.github/action-policy.yaml` 中声明的 Agent 能力发送到 TypeSafe Jev（`api.typesafe.ai`）。不要在 Issue 内容中放入密钥、个人学习备份或其他不应发送给该服务的信息。密钥只通过 GitHub Actions Secret 提供，不写入仓库或日志。

## 执行边界

TypeSafe Jev 只判断当前阶段是否适合常规模型，并选择 `action:agent` 或 `action:human`。它不会开发、测试、审查代码或创建 PR。当前 `.github/action-policy.yaml` 中 `agents` 为空，仓库没有配置真正领取任务的执行 Agent；`action:agent` 只是分配标签，必须接入外部执行器后才会执行代码任务。

外部执行器应遵循 `.github/protocols/agent-action-protocol.md`：成功时先记录结果和 PR，再移除当前 action 标签；失败时添加 `state:agent-failed`、移除当前阶段标签，最后移除 action 标签。执行器应使用有 Issue 写权限的 GitHub App Token 或 PAT 来改标签，这样 GitHub 才会触发后续工作流；GitHub Actions 自带的 `GITHUB_TOKEN` 不会触发新的工作流运行。

评审或 API 请求失败时，工作流不会默认分配人工或 Agent 标签。修复配置或服务问题后，重新添加当前 `state:*` 标签即可再次评审。
