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

受保护路径只有在它**是某个写动词的实参**时才计数。判定把命令切成语句，找出每条语句里的写动词
（`Set-Content`、`Remove-Item`、`WriteAllText`、`>` 等），再解析这个动词自己的实参——可能是字面路径，
也可能是命令里更早赋给变量的路径（`$p = Join-Path $env:USERPROFILE '.dsh\guardrails\policy.json'; Set-Content $p`）。
只是"出现在命令里"的路径不算目标：执行 bundled node（`& "…\.dsh\…\node.exe" x.mjs`）或用 `Get-Content`
读一个文件，都不会让附近的 `Set-Content` 变成写它——卡片也不会再把一个程序说成"即将被覆盖的对象"。

`observe` 与 `allow` 是 P3 新增的档位，只在 `"version": 2` 下存在。`version: 1` 的文件行为与从前完全一致：
`allow` 仍被当作 `ask`、`observe` 在加载时直接拒绝（`observe-requires-v2`），所以旧配置不会因为升级而悄悄改变含义。

自保护（`rules.selfProtect`）只接受 `ask`、`deny`，以及 `"version": 2` 下的 `observe`；`off` 与 `allow` 都会被拒绝
——一个能被它保护的文件关掉的开关不算护栏。`observe` 是开发期的临时约定：改护栏自身源码不再弹卡，改为记一条
`observed`，改完可回看，但不是可以随发布带出去的档位。它保护的是宿主真正加载的那个插件目录，所以用工具改
`rules.js` 或 `lib/` 会弹卡。它**不是沙箱**：手工编辑、别的进程、插件进程内部的 `fs` 写、以及参数里只有 patch
文本的 `apply_patch` 都不经过它。

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
  "version": 2,
  "enabled": true,
  "rules": {
    "protectDshHome": { "mode": "ask", "roots": ["~/.dsh", "~/.agents"] },
    "destructive":    { "mode": "ask", "patterns": [] },
    "secrets":        { "mode": "ask", "patterns": [] },
    "selfProtect":    { "mode": "ask", "paths": [] }
  },
  "entries": [
    {
      "id": "no-dist-delete",
      "tool": ["pwsh"],
      "mode": "deny",
      "when": { "commandMatches": "^\\s*Remove-Item\\b.*\\\\dist\\b" }
    }
  ]
}
```

`patterns` 用来在内置清单之外追加你自己的正则。

## 自定义条目（P3，`version: 2`）

一条 entry 的意思是"这个工具、在这些条件下、得到这个处置"。`when` 的三个条件必须同时成立
（`cwdUnder`、`targetUnder`、`commandMatches`）；不写 `when` 则对所列工具的每次调用都生效。`targetUnder`
是路径判断，对 shell 命令里的内联文本不生效——这类用 `commandMatches`，并且必须以 `^` 锚定（未锚定的
正则在加载时就被拒绝）。

四种处置的优先级是 `deny` > `ask` > `observe` > `allow`。条目与内置规则在同一张排序里竞争：所以
`entries.deny` 能把已经降到 `ask` 的块重新收紧，而 `entries.allow` 永远盖不过内置命中——它只记录
"这条被显式声明允许"（rank 0）。卡片上用中文说人话（`自定义规则 no-dist-delete 禁止此调用`），
审计记录里仍是 `rule: "E"` 加 `entryId`，全部命中在 `reasons[]` 里。

## 想放宽时

要让某一类命令不再弹审批，走"降块级 `mode`，再把危险的那几条捞回来"：

- `"mode": "deny"` 整块拒绝；`"off"` 整块关闭（连记录都没有）。
- `"mode": "observe"`（`version: 2`）全部放行，但写一条 `observed` 记录——预演档，用来看某条规则要是上线
  会多频繁地命中，再决定要不要信任它。
- `"mode": "allow"`（`version: 2`）全部放行，写一条 `allowed` 记录。
- 或者打开 `rules.quiet`（P1.7；旧位置 `rules.destructive.workspaceQuiet` 仍然有效）：工作区内的删除不问，临时目录与递归删除照问。
  命中同一次调用的 `observe` 条目不会把静默关掉——它只进 `reasons` 留痕，不构成否决。
- 然后用 `entries` 里 `mode: "deny"` 把必须拦住的命令写回去（rank 3 在放宽过的块里仍然赢）。

`version: 1` 下只有第一条可用：`allow` 被当作 `ask`、`observe` 加载即拒，旧文件保持旧行为。
`entries.allow` 从来不是"给误拦开白"的手段——它排在所有内置 `ask`/`deny`/`observe` 之后。

## 从命令行问一句（P3）

`dsh-guardrails check`（或 `node tools/check.mjs`）把一次工具调用送进宿主用的同一个引擎，用退出码回答：

    node tools/check.mjs --tool pwsh --args '{"command":"git reset --hard"}'

退出码：`0` 放行（含 `observe` 与工作区静默放行）、`2` 会弹审批卡、`3` 拒绝、`1` 用法或策略错误——
`1` 永远不表示"放行"，脚本不会把打错的参数当成许可。加 `--json` 得到
`{decision, exitCode, winner, reasons, facts, cwd}`；想区分 `observe` 和普通放行，看 `winner.mode`。

- `--args -` 从标准输入读参数。Windows 上这是可靠写法：PowerShell 会拆分并重新加引号，内联 JSON 可能
  传到 CLI 时已经变形。
- `--cwd <path>` 决定相对路径的基准。只有 CLI 默认用当前目录；宿主从不拿 `process.cwd()` 当工具调用的目录。
- CLI 不写审计、不刷心跳：它只是提问，不是执行。

策略文件无效时这里直接报错（退出码 1），不做静默回退：一次性的提问没有"上一份好策略"可留，而宿主那种
"保留上一份"的行为会把拼写错误藏起来。

## 装上之后

- **审计**：`~/.dsh/guardrails/audit/v2/`——`requested` / `delivered` / `outcome` / `executed` 事件流，
  外加可选的 `allowed`（P1.7 工作区静默放行，以及 `mode: "allow"` 的块）和 `observed`（`mode: "observe"`
  的块，P3）；带哈希链；命令原文在 `payload/`。**密钥既不入盘也不留哈希**——低熵密钥的哈希等于一个可离线
  爆破的校验值，所以密钥记录只有 `payloadBytes`。唯一例外是 `observe` 下的密钥命中：先把命中片段替换成
  `<redacted:label>` 再落盘，落盘前复扫仍有命中就整条不写（`redacted` 记下标签）。
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
