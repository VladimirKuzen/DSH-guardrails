# DSH 护栏

挂在 DSH 的 `tools/pre-execute` 瀑布上的一个小门禁，在工具调用**执行之前**做判定：命中就拒绝，
或者弹一次性的审批；每次命中同时写进本地审计。

仅支持 Windows。

## 它盯什么

| 规则 | 触发条件 | 默认 |
|---|---|---|
| **R1** DSH 自身目录 | 写入落在 `~/.dsh` 或 `~/.agents`；shell 命令同时提到这些目录并带写/删/移动动词；任何 `plugin_manager` 操作 | 弹审批 |
| **R2** 破坏性命令 | 命令位置上的删除/移动/改名，`robocopy /MIR`、`git reset --hard`、`git clean -f`、`format`、`diskpart`、`reg add/delete/import`、`sc create/config/delete`、`schtasks`、`netsh advfirewall`、`Set-MpPreference`、`takeown`、`icacls`、`chkdsk /f`、`dism /remove-*`、`sfc /scannow` | 弹审批 |
| **R2 critical** | 格式化/分区磁盘、`diskpart /s`、启动配置写入、删除 `HKLM\SYSTEM`/`HKLM\SAM`、写/删/移 `%SystemRoot%` 或 `%ProgramFiles%` 下的内容、`takeown`/`icacls` 指向这些目录 | 直接拒绝 |
| **R3** 参数里的密钥 | Ark / `sk-` / `AKIA` / `ghp_` / `AIza` / `xox` / Bearer / 私钥块 / `key=...` 赋值 | shell 命令直接拒绝；文件写入弹审批，只记类型 |

每条规则都可以切成 `deny`（直接拒绝）或 `off`（关闭）；critical 级另可用 `rules.critical.mode`
设成 `ask`（降级为带 ⛔ 的审批卡）或 `off`（退回普通 R2）；`rules.critical.failClosed`（默认开）
让这一层在判定本身抛异常时仍然保持拒绝。

## 配置

策略文件在插件之外：`~/.dsh/guardrails/policy.json`，两秒内重读，改完不用重启：

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

`patterns` 用来在内置清单之外追加你自己的正则。

## 装上之后

- **审计**：`~/.dsh/guardrails/audit/audit-YYYY-MM-DD.jsonl`，每次被拦截的调用一行。
- **心跳**：`~/.dsh/guardrails/loaded.json`。判据是“修改时间新鲜 + 版本一致”，pid 不可信。
- **不新增常驻进程**：它跑在 DSH 宿主进程里。

## 限制

- 只看得到工具调用。直接写进对话的文本不经过它。
- 不是沙箱。有本机权限的人仍然可以直接改文件。
- 基于模式匹配。混淆过的 shell 可以绕开破坏性命令那几条。

## 安装之后

启用 bundle，然后看 `~/.dsh/guardrails/loaded.json` 的时间戳是否新鲜。如果它是旧的，说明插件没挂上
——不要假设门禁在工作。
