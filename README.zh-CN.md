# dsh-guardrails

[English](README.md) | **中文**

给 **DSH** 用的一个轻量护栏：在工具调用真正执行**之前**拦下高危操作，并在本地留下审计记录。
零运行时依赖。

- **宿主原生**：监听 `tools/pre-execute` 的 DSH 插件。没有守护进程、没有代理、不额外起进程。
- **确定性判定**：只用路径和正则规则。不调用模型、不联网，也不依赖"发起动作的那个模型"来判断自己。
- **可审计**：每次被拦截的调用写一行 JSONL；密钥永远不以明文落盘。
- **仅 Windows**，1.0 之前。路径语义按 Windows 处理（`~`、`%VAR%`、`$env:VAR`、反斜杠）。

## 为什么需要它

Agent 最危险的时刻，是"一句话"变成"一个动作"的那一秒：它可能改写自己的配置、删掉一条它看错的目录、
把 API key 粘进日志。写在提示词里的规则拦不住这些。这个门禁站在执行前的最后一跳，要么问人，要么拒绝。

## 三条规则

| 规则 | 触发条件 | 默认动作 |
|---|---|---|
| **R1** 保护 DSH 自身目录 | 工具写入落在 `~/.dsh` 或 `~/.agents` 下；shell 命令同时提到这些目录并带有写/删/移动动词；任何 `plugin_manager` 操作 | 弹审批 |
| **R2** 破坏性操作 | 命令位置上的删除/移动/改名，`robocopy /MIR`、`git reset --hard`、`git clean -f`、`format`、`diskpart`、`reg delete`、`sc delete`、`takeown`、`icacls` 改权限 | 弹审批 |
| **R3** 工具参数里的密钥 | Ark / `sk-` / `AKIA` / `ghp_` / `AIza` / `xox` / Bearer / 私钥块 / `key=...` 赋值 | 弹审批（只记类型，不记原文） |

每条规则都可以设成 `ask`（弹审批）、`deny`（直接拒绝）或 `off`（关闭）。
只读调用、以及工作区里的正常写操作，都不受影响。

## 一次调用是怎么被判定的

```
工具调用 ──▶ evaluate(policy, call, env) ──▶ null ──────────────▶ 放行
                                              └─▶ { rule, mode } ──▶ 写审计 + 刷心跳
                                                                     ├─ ask  → 弹审批（仅此一次）
                                                                     └─ deny → 拒绝，并把原因回给模型
```

插件是 **fail-open** 的：策略解析或规则判定抛异常时，调用继续执行。护栏不能把工具链搞死。
如果插件压根没挂载，宿主就在无保护状态下跑——正因为如此才有 `loaded.json`（见下）。

## 安装

需要 Windows 上的 DSH。包还没上 registry，用本地链接挂进 profile：

1. 在 `%USERPROFILE%\.dsh\profiles\<profile>\package.json` 的依赖里加：

   ```json
   "@vlad/dsh-guardrails": "link:<指向本仓库的绝对路径>\\dsh-guardrails"
   ```

2. 在同一个文件的 `dsh.profile.bundles` 里加上 `@vlad/dsh-guardrails`。
3. 在 profile 目录执行 `pnpm install`。
4. 重启 DSH。宿主插件不会热重载。

确认它挂上了：`~/.dsh/guardrails/loaded.json` 的修改时间是最近的，且版本与
`dsh-guardrails/package.json` 一致。**不要看 pid**——宿主进程会被替换，而门禁可能在新进程里继续工作。
"时间新鲜 + 版本一致"才是判据。

## 配置

| 内容 | 位置 |
|---|---|
| 策略 | `~/.dsh/guardrails/policy.json`——2 秒内重新读取，不用重启 |
| 策略覆盖 | 环境变量 `DSH_GUARDRAILS_POLICY` |
| 审计 | `~/.dsh/guardrails/audit/audit-YYYY-MM-DD.jsonl`（按本地日期） |
| 心跳 | `~/.dsh/guardrails/loaded.json` |

```json
{
  "version": 1,
  "enabled": true,
  "rules": {
    "protectDshHome": { "mode": "ask", "roots": ["~/.dsh", "~/.agents"] },
    "destructive":    { "mode": "ask", "patterns": [] },
    "secrets":        { "mode": "ask", "patterns": [] }
  }
}
```

`patterns` 用于在内置清单之外追加你自己的正则。策略文件写坏时会被忽略并沿用上一份好配置——
门禁不会因为一次误编辑而消失。

## 仓库结构

| 路径 | 用途 |
|---|---|
| `dsh-guardrails/` | 插件本体：`index.js`（宿主接线）、`rules.js`（纯判定逻辑） |
| `dsh-guardrails/test/` | 规则测试与打包冒烟测试 |
| `docs/` | 设计文档与实施计划 |
| `scripts/` | 维护者工具：审计脱敏、快照/恢复、健康检查。**不随插件发布** |

之所以有这套工具，是因为审计文件里含命令原文和路径。它在本地做快照与脱敏，再用 Windows DPAPI
加密（绑定当前用户账户）。

## 开发

无构建、无运行时依赖，测试直接跑：

```powershell
node dsh-guardrails/test/rules.test.mjs
node dsh-guardrails/test/plugin.smoke.mjs
```

要用 `node <文件>` 而不是 `node --test`：DSH 沙箱不允许测试运行器派生子进程。

## 已知限制

- **不是沙箱。** 它只看得到工具调用。直接粘贴进对话的文本绕过它；有本机权限的人也能直接改文件。
- **规则基于正则与路径。** 混淆过的 shell（变量拼接、`cmd /c`、`powershell -enc`）可以绕开破坏性命令
  的匹配；三条规则里路径判定（R1）最扎实。
- **审批界面不完全受插件控制。** 弹窗由宿主渲染，插件只能提供文案。
- **现在的审计只记录"命中"，不记录"决定"。** 记录人工决策在路线图上。
- 仅 Windows。

## 卸载

从 profile 的 `dsh.profile.bundles` 和 `dependencies` 里删掉 `@vlad/dsh-guardrails`，重启 DSH。
已有审计文件不会自动删除；需要的话自行清理。

## 许可证

MIT。
