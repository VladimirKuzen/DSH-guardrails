# DSH 护栏

挂在 DSH 的 `tools/pre-execute` 瀑布上的一个小门禁，在工具调用**执行之前**做判定：命中就拒绝，
或者弹一次性的审批；每次命中同时写进本地审计。

仅支持 Windows。

## 它盯什么

| 规则 | 触发条件 | 默认 |
|---|---|---|
| **R1** DSH 自身目录 | 写入落在 `~/.dsh` 或 `~/.agents`；shell 命令同时提到这些目录并带写/删/移动动词；任何 `plugin_manager` 操作 | 弹审批 |
| **R1 self** 护栏自身源码 | 写入或带写动词的 shell 命令落在本插件目录（以及 `rules.selfProtect.paths` 里追加的根） | 弹审批 |
| **R2** 破坏性命令 | 命令位置上的删除/移动/改名，`robocopy /MIR`、`git reset --hard`、`git clean -f`、`format`、`diskpart`、`reg add/delete/import`、`sc create/config/delete`、`schtasks`、`netsh advfirewall`、`Set-MpPreference`、`takeown`、`icacls`、`chkdsk /f`、`dism /remove-*`、`sfc /scannow` | 弹审批 |
| **R2 critical** | 格式化/分区磁盘、`diskpart /s`、启动配置写入、删除 `HKLM\SYSTEM`/`HKLM\SAM`、写/删/移 `%SystemRoot%` 或 `%ProgramFiles%` 下的内容、`takeown`/`icacls` 指向这些目录 | 直接拒绝 |
| **R3** 参数里的密钥 | Ark / `sk-` / `AKIA` / `ghp_` / `AIza` / `xox` / Bearer / 私钥块 / `key=...` 赋值 | shell 命令直接拒绝；文件写入弹审批，只记类型 |

每条规则都可以切成 `deny`（直接拒绝）或 `off`（关闭）；critical 级另可用 `rules.critical.mode`
设成 `ask`（降级为带 ⛔ 的审批卡）或 `off`（退回普通 R2）；`rules.critical.failClosed`（默认开）
让这一层在判定本身抛异常时仍然保持拒绝。

自保护（`rules.selfProtect`）是唯一只接受 `ask` / `deny` 的规则：一个能被它保护的文件关掉的开关不算护栏。
它保护的是宿主真正加载的那个插件目录，所以用工具改 `rules.js` 或 `lib/` 会弹卡。它**不是沙箱**：手工编辑、
别的进程、插件进程内部的 `fs` 写、以及参数里只有 patch 文本的 `apply_patch` 都不经过它。

## 描述不清的删除先预演（P1.8）

卡片只有一行：`⚠ 删除｜不可恢复`。命令的目标是变量（`Remove-Item "$dir\$name" -Recurse`）、命令很长、
或者连着好几处删除时，这一行就是审批能看到的全部——这不够用来同意。

打开 `rules.destructive.dryRun.enabled`（默认 `false`）后，第一次尝试不弹卡，而是直接拒绝，并要求先用
只读命令把确切路径列出来；同一会话里同样形状的命令第二次尝试才弹普通卡片，正文多一行"首次尝试已要求预演"。

```json
"destructive": {
  "mode": "ask",
  "dryRun": { "enabled": true, "minChars": 400, "minStatements": 3, "dynamicTarget": true }
}
```

护栏无法验证清单是否真的跑过，它只是让第一次尝试以"先给清单"的方式失败；同一命令重试即放行，所以这是
"推一把"而不是校验。卡片本来就能说清的命令（目标是个字面量、单条）不会被延迟。

## 卡片说什么

卡片回答的是这一次调用的三个问题，而不是工具本身：做什么（删除、移动、覆盖、写注册表）、对什么（目标
路径，超过 72 字符截断显示）、能不能撤销。

两条规则保证命令不规整时这些仍然靠得住：

- **说最坏的那个动作，不说第一个。** `New-Item …; Remove-Item …` 读作"删除"。报出无害的准备步骤，等于
  把不可逆的那一步藏起来。
- **目标是变量决定的，就明说。** 路径来自变量时，卡片写"目标由变量决定"；走过预演之后写"见上面的只读
  清单"——不再整段省略，那样读起来像"没有目标"。

卡片仍然放不下命令本身：命令由宿主单独渲染、长参数会被截，审批请求里也没有我们自己的正文位置。所以
把命令压缩成事实是唯一手段，上面那条预演就是为此存在的。

## 配置

策略文件在插件之外：`~/.dsh/guardrails/policy.json`，两秒内重读，改完不用重启。文件会按
`policy.schema.json` 校验（未知键直接拒绝，拼错一个键不会悄悄关掉规则）；校验失败的文件不会被采用，
上一份好策略继续生效，同时留一条 `config-invalid` 审计并在宿主日志里警告一次：

```json
{
  "version": 1,
  "enabled": true,
  "rules": {
    "protectDshHome": { "mode": "ask", "roots": ["~/.dsh", "~/.agents"] },
    "destructive":    { "mode": "ask", "patterns": [] },
    "secrets":        { "mode": "ask", "patterns": [] },
    "selfProtect":    { "mode": "ask", "paths": [] }
  }
}
```

`patterns` 用来在内置清单之外追加你自己的正则。

## 想放宽时

要让某一类命令不再弹审批，`policy.json` 里只有两个方向：把整块的 `mode` 调成 `deny`/`off`，或者打开
`destructive.workspaceQuiet`（工作区内的删除不问）。**把 `mode` 写成 `"allow"` 不放宽任何东西**——R1 / R2 / R3
今天都把它当作 `ask`（`dsh-guardrails/lib/rules/r2-destructive.js:63`），写了只会让你以为已经放行。

P3 之后会多一张 `entries` 表（尚未实现，见 `design/p3-policy-v2.md` §2.2）：其中的 `allow` 条目优先级最低，
永远盖不过内置规则的 `ask`/`deny`/`observe`，它只负责留下“这条命令被显式声明允许”的审计痕迹，不能用来给误拦开白。
真正要放宽，走的是“降块级 `mode`，再用 `entries.deny` 把危险的那几条捞回来”。

## 装上之后

- **审计**：`~/.dsh/guardrails/audit/v2/`——`requested` / `delivered` / `outcome` / `executed` 事件流，
  外加可选的 `allowed`（P1.7 工作区静默放行）；带哈希链；命令原文在 `payload/`，密钥只留哈希。
  用 `node tools/audit-report.mjs --stats --verify` 读取。
- **心跳**：`~/.dsh/guardrails/loaded.json`。判据是“修改时间新鲜 + 版本一致”，pid 不可信。
- **不新增常驻进程**：它跑在 DSH 宿主进程里。

## 限制

- 只看得到工具调用。直接写进对话的文本不经过它。
- 不是沙箱。有本机权限的人仍然可以直接改文件。
- 自保护只是路障不是边界：它挡的是“用工具改护栏”，挡不住手工编辑、别的进程、以及插件内部自己发起的写。
- 基于模式匹配。混淆过的 shell 可以绕开破坏性命令那几条。
- 预演只是"推一把"：同一条命令重试就放行，护栏也判断不出清单到底跑没跑。

## 安装之后

启用 bundle，然后看 `~/.dsh/guardrails/loaded.json` 的时间戳是否新鲜。如果它是旧的，说明插件没挂上
——不要假设门禁在工作。
