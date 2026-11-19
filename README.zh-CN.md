# dsh-guardrails

[English](README.md) | **中文**

给 **DSH** 用的一个轻量护栏：在工具调用真正执行**之前**拦下高危操作，并在本地留下审计记录。
零运行时依赖。

- **宿主原生**：监听 `tools/pre-execute` 的 DSH 插件。没有守护进程、没有代理、不额外起进程。
- **确定性判定**：只用路径和正则规则。不调用模型、不联网，也不依赖"发起动作的那个模型"来判断自己。
- **可审计**：每次被拦截的调用写一行 JSONL；密钥永远不以明文落盘。
- **仅 Windows**，1.x。路径语义按 Windows 处理（`~`、`%VAR%`、`$env:VAR`、反斜杠）。

**状态**：v1.5.1。P1.6 系统级硬停与审计 v2 已在 Windows 11 上完成 live 验收（2026-11-15）：deny 不弹卡、
命令不执行；批准后的调用产生完整的 `requested → delivered → outcome → executed` 链并带 payload；
`--verify` 能校验哈希链。此后又加入了排序引擎（`version: 2`）、自定义 `entries`、`observe`、
两阶段预演、工作区静默与 `check` 命令行，并逐项做过 live 验收；每一步的原因与验证方式记在
`CHANGELOG.md` 与 `design/p3-policy-v2.md`。

## 文档地图

| 页面 | 什么时候读 |
|---|---|
| [docs/DETAIL.zh.md](dsh-guardrails/docs/DETAIL.zh.md)（[English](dsh-guardrails/docs/DETAIL.md)） | 想知道卡片说什么、为什么这么判 |
| [docs/POLICY.zh.md](dsh-guardrails/docs/POLICY.zh.md)（[English](dsh-guardrails/docs/POLICY.md)） | 想改行为——档位、`entries`、模板 |
| [docs/ARCHITECTURE.md](dsh-guardrails/docs/ARCHITECTURE.md) | 要改代码，需要文件地图 |
| [docs/DSH-API.md](dsh-guardrails/docs/DSH-API.md) | 要升级 DSH，或者有东西悄悄失灵 |
| [CHANGELOG.zh-CN.md](CHANGELOG.zh-CN.md)（[English](CHANGELOG.md)） | 想看历史与理由 |
| [SECURITY.md](SECURITY.md) | 你找到了一条穿过去的路径 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 想加一条规则，或改策略格式 |
| [design/](design/) | 想看测量数据与被否掉的方案 |

## 为什么需要它

Agent 最危险的时刻，是"一句话"变成"一个动作"的那一秒：它可能改写自己的配置、删掉一条它看错的目录、
把 API key 粘进日志。写在提示词里的规则拦不住这些。这个门禁站在执行前的最后一跳，要么问人，要么拒绝。

## 规则

| 规则 | 触发条件 | 默认动作 |
|---|---|---|
| **R1** 保护 DSH 自身目录 | 写动词的实参落在 `~/.dsh` 或 `~/.agents` 下，含 `apply_patch` 文本里点名的目标；任何 `plugin_manager` 操作 | 弹审批 |
| **R1 self** 保护插件自身 | 写入目标是本插件的源码目录——包括 `apply_patch` 正文里出现的路径与 `*** Move to:` 目的地 | 弹审批 |
| **R2** 破坏性操作 | 命令位置上的删除/移动/改名，`robocopy /MIR`、`git reset --hard`、`git clean -f`、`format`、`diskpart`、`reg add/delete/import`、`sc create/config/delete`、`schtasks`、`netsh advfirewall`、`Set-MpPreference`、`takeown`、`icacls`、`chkdsk /f`、`dism /remove-*`、`sfc /scannow` | 弹审批 |
| **R2 critical**（严重级） | 格式化/分区磁盘、`diskpart /s`、启动配置写入（`bcdedit`、`bootrec`、`vssadmin delete`、`wbadmin delete`、`reagentc`）、删除 `HKLM\SYSTEM` 或 `HKLM\SAM`、写/删/移动 `%SystemRoot%` 或 `%ProgramFiles%` 下的内容、`takeown`/`icacls` 指向这些目录 | 直接拒绝 |
| **R3** 工具参数里的密钥 | Ark / `sk-` / `AKIA` / `ghp_` / `AIza` / `xox` / Bearer / 私钥块 / `key=...` 赋值 | shell 命令直接拒绝；文件写入弹审批（只记类型） |
| **E** 你自己写的 `entries` | 你设定的工具、工作区、目标、命令条件 | 由你设定 |

每一层都可以设成 `ask`、`deny` 或 `off`；`version: 2` 额外提供 `observe` 与 `allow`（以及 `entries`）。
v2 下各层按 `deny > ask > observe > allow` 排序、取最严的一条，所以用户写的 `allow` 永远盖不过内置的
`ask`。

**critical 级是直接拒绝，不弹卡片**：一次“允许一次”就可能让 Windows 起不来，磁盘编号、分区表、
配置单元内容这些目标信息从命令文本里根本确认不了，而且错了要重启才发现。拒绝时会把英文原因
回给模型；确实要做，请自己到终端里执行。只读诊断（`Get-Disk`、`diskpart list disk`、
`bcdedit /enum`、`vssadmin list shadows`、`reagentc /info`、`dism /scanhealth`）仍然放行，
工作区里的普通删除仍然只是弹审批。把 `rules.critical.mode` 设成 `ask` 可以降级为审批卡（⛔ 前缀），
设成 `off` 则退回普通 R2。

只读调用、以及工作区里的正常写操作，都不受影响。

R3 故意更严格：宿主会按工具调用原样回显 shell 命令，如果走“弹审批”，密钥就直接显示在卡片上。
所以 shell 命令里的密钥一律直接拒绝；文件写入的正文不会被回显，仍然弹审批。v2 下把
`secrets.mode` 设成 `"observe"` 则只记录不拦——payload 存的是脱敏文本（`<redacted:openai>`），
哈希也只对脱敏文本算。

自保护存在的理由是：门禁自己的规则是最容易被削弱的那个文件。它接受 `ask`、`deny`，以及 v2 下的
`observe`；**永远不接受 `off`**——一个能被它保护的那个文件关掉的开关，不是护栏。

## 一次调用是怎么被判定的

```
工具调用 ──▶ evaluate(policy, call, env) ──▶ null ──────────────▶ 放行
                                              └─▶ { rule, mode } ──▶ 写审计 + 刷心跳
                                                                     ├─ ask  → 弹审批（仅此一次）
                                                                     └─ deny → 拒绝，并把原因回给模型
```

`version: 2` 下每层都报结果、取最严的一条，次严的命中落进审计的 `reasons`（最多 8 条）。之后还有两个
后处理：**工作区静默**可以把一次例行删除变成无卡放行，**预演**可以对"卡片描述不清"的破坏性命令先拒一次。

插件是 **fail-open** 的：策略解析或规则判定抛异常时，调用继续执行。护栏不能把工具链搞死。
唯一的例外是 critical 层：判定流程本身坏掉时，仍然命中危险模式的 shell 命令会被拒绝
（`rules.critical.failClosed`，默认开）。如果插件压根没挂载，宿主就在无保护状态下跑——正因为如此才有
`loaded.json`（见下），它现在还写 `surface: "ok" | "degraded"`，让"宿主接口变了"当场可见，而不是看起来一切正常。

## 安装

需要 Windows 上的 DSH。开发针对 DSH desktop `0.2.2-rc.1`，在干净机器上用 `0.2.2-rc.3` 验收，宿主升级后又
在 `0.2.2-rc.5` 上复验；其他宿主版本未测。包声明了 `engines.dsh: ">=0.2.0-0"`，但没有观察到宿主校验它。

> **运行时是懒加载的。** DSH 自带的 `node` 与 `pnpm` 在第一次**真正需要**时才解压，不是第一次启动就解压：
> 全新安装后只启动一次，`%USERPROFILE%\.dsh\dsh-runtimes\` 不会出现。先用一次会调外部命令的工具，或者让
> 插件管理器装一个 bundle，目录就出来了。仍然没有的话，安装包里带着同一份载荷，路径是
> `%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\primary-runtime\`：把它拷到
> `%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\`；或者自己装 Node LTS 和 `pnpm`，用 PATH 上的那两份。

**从 Plugins 页面安装** —— 最短的一条，不需要开 shell：

1. 打开 DSH，进 **Plugins** 页。
2. 点 **Add plugin**，粘贴 `@vladimirkuzen/dsh-guardrails`，安装源保持默认（或选 npm 官方源）。
3. 安装，然后重启 DSH。起来之后确认它挂上了（见[确认已挂载](#确认已挂载)）。

同一个对话框也接受 Git 地址和本机目录，所以未发布的检出也能装，不用手改 JSON。

**从 npm 安装（命令行）** —— 包已发布为 `@vladimirkuzen/dsh-guardrails`：

```powershell
dsh plugin --profile desktop add @vladimirkuzen/dsh-guardrails
```

`dsh plugin` 会把它转给 profile 目录里的 `pnpm`，并自动启用该 bundle，不需要手改 JSON；web 档位用
`--profile web`。之后重启 DSH。桌面安装包不会把 `dsh` 放进 `PATH`，所以在普通 shell 里要调应用自带的那份
（该 CLI 在运行时解压前能不能用，未验证——Plugins 页面没有这个依赖）：

```powershell
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add @vladimirkuzen/dsh-guardrails
```

**从仓库检出安装** —— 想跑未发布的改动时：

1. `git clone https://github.com/VladimirKuzen/DSH-guardrails.git`
2. 在 `%USERPROFILE%\.dsh\profiles\<profile>\package.json` 的依赖里加：

   ```json
   "@vladimirkuzen/dsh-guardrails": "link:<检出目录的绝对路径>\\dsh-guardrails"
   ```

3. 在同一个文件的 `dsh.profile.bundles` 里加上 `@vladimirkuzen/dsh-guardrails`。
4. 在 profile 目录执行 `pnpm install`。干净机器上 `pnpm`（和 `node`）都不在 `PATH` 里——DSH 自带运行时——
   所以用自带的那份：

   ```powershell
   $deps = (Get-ChildItem "$env:USERPROFILE\.dsh\dsh-runtimes\*\dependencies" -Directory)[0]
   & "$($deps.FullName)\node\bin\node.exe" "$($deps.FullName)\pnpm\bin\pnpm.mjs" install
   ```

5. 重启 DSH。宿主插件不会热重载。

### 确认已挂载

不管走哪条路，`~/.dsh/guardrails/loaded.json` 的修改时间都应该是最近的、版本与
`dsh-guardrails/package.json` 一致、且 `surface` 是 `"ok"`。**不要看 pid**——宿主进程会被替换，
而门禁可能在新进程里继续工作。"时间新鲜 + 版本一致 + surface"才是判据。

## 配置

| 内容 | 位置 |
|---|---|
| 策略 | `~/.dsh/guardrails/policy.json`——2 秒内重新读取，不用重启 |
| 策略覆盖 | 环境变量 `DSH_GUARDRAILS_POLICY` |
| 审计 | `~/.dsh/guardrails/audit/v2/`——按日一个 JSONL、原文 payload、哈希链 |
| 心跳 | `~/.dsh/guardrails/loaded.json` |

```json
{
  "version": 2,
  "enabled": true,
  "audit": { "format": "v2", "maxPayloadBytes": 65536 },
  "rules": {
    "protectDshHome": { "mode": "ask", "roots": ["~/.dsh", "~/.agents"] },
    "critical":       { "mode": "deny", "patterns": [], "failClosed": true },
    "destructive":    { "mode": "ask", "patterns": [],
                        "dryRun": { "enabled": false, "minChars": 400, "minStatements": 3, "dynamicTarget": true } },
    "secrets":        { "mode": "ask", "patterns": [] },
    "selfProtect":    { "mode": "ask", "paths": [] },
    "quiet":          { "enabled": false,
                        "roots": ["D:\\work\\guardrails"],
                        "paths": ["_scratch", "build", "dist"],
                        "alwaysAsk": [".git", ".", ".."] }
  },
  "entries": [
    { "id": "no-force-push", "tool": ["pwsh", "bash"], "mode": "deny",
      "when": { "commandMatches": "^\\s*git\\s+push\\b[^|;]*--force" } }
  ]
}
```

示例里的 `D:\work\guardrails` 与页面上命令里的路径都是占位符——换成本机真实存在的目录。

`patterns` 用于在内置清单之外追加你自己的正则；`critical.patterns` 追加到硬停层；
`critical.failClosed` 让硬停层在判定异常时保持关闭状态。策略文件写坏时会被整份忽略并沿用上一份好配置——
门禁不会因为一次误编辑而消失——同时写一条 `config-invalid`，记录里点名哪个字段错了。
`audit.format: "v1"` 可退回旧的单文件日志。

`rules.quiet`（默认关闭）只把“清理自己工作区里的临时文件”从弹卡变成静默放行，条件是：
shell 命令只有一条语句、只有一个目标、不带 `-Recurse`、不含通配符、路径是绝对路径且位于 `roots` 之下、
并且落在 `paths` 的某一项下层。`-Force` 在上述条件都满足时允许。其余情形照常弹卡；R1、R3 与 critical
层完全不受影响。若拿到的 cwd 不在 `roots` 下，quiet 会整体关闭并写一条 `config-invalid`；拿不到 cwd 时，
带 `cwdUnder` 的 `entries` 不会命中，同样写一条 `config-invalid` 说明原因。旧位置
（`rules.destructive.workspaceQuiet`）仍然有效并在加载时迁移，但两处同时写会被拒绝。

`entries` 是写自己规则的地方；里面的 `mode: "allow"` 是"声明 + 留痕"，不是豁免。放宽的三步走、
以及"降档 + 用 `entries.deny` 把危险子集捞回来"的做法，见
[docs/POLICY.zh.md](dsh-guardrails/docs/POLICY.zh.md)；模板在 `dsh-guardrails/examples/policy/`，
每份都由测试校验。

## 不经过宿主直接问一句

```powershell
'{"command":"Remove-Item D:\\work\\a.txt -Force"}' |
  node dsh-guardrails/tools/check.mjs --tool pwsh --args - --json
node dsh-guardrails/tools/check.mjs --policy .\policy.json --validate
```

在 Windows PowerShell 里参数要走标准输入（`--args -`）：PowerShell 会给内联参数重新加引号，
`--args '{"command":"…"}'` 可能到不了程序手里。`cmd.exe` 里内联写法可用。

退出码：`0` 放行、`2` 需要审批、`3` 拒绝、`1` 用法或策略错误——`1` 绝不表示放行。它调用与宿主同一个
`evaluate()` 和同一段 quiet 后处理；不写审计、不刷心跳。

## 审计

每次被拦的调用会写成共享同一个 `id` 的一串事件：闸门处的 `requested`、审批服务接手时的 `delivered`、
用户或护栏作出决定时的 `outcome`、批准后真正执行完的 `executed`；静默放行写 `allowed`（带
`quiet: "workspace"`），v2 的观察档写 `observed`。记录用 `prevHash` 串成哈希链，被编辑或截断的行能被发现；
命令原文存在 `payload/`，密钥形状的片段替换成 `<redacted:label>`，而被拒绝的密钥**连哈希都不留**。
`cwd` 与 `cwdSource`（`session` / `tool` / `null`）记录判定时的工作目录；`reasons`、`entryId`、
`reasonsTruncated` 说明为什么、由哪一层判的；配置错误写 `config-invalid`，并带 `reason` 与 `detail`。

离线读取：

```powershell
node dsh-guardrails/tools/audit-report.mjs            # 最近 20 条
node dsh-guardrails/tools/audit-report.mjs --stats     # 按事件 / 规则 / 结果统计
node dsh-guardrails/tools/audit-report.mjs --verify    # 校验哈希链，断裂时退出码 1
node dsh-guardrails/tools/audit-report.mjs --event observed --rule R1
```

## 仓库结构

| 路径 | 用途 |
|---|---|
| `dsh-guardrails/` | 插件本体：`index.js`（宿主接线）、`rules.js`（纯判定逻辑）、`lib/`（匹配器、事实、卡片、审计）、`policy.schema.json` |
| `dsh-guardrails/docs/` | `DETAIL`、`POLICY`、`ARCHITECTURE`、`DSH-API`（适合的都有中英两份） |
| `dsh-guardrails/examples/policy/` | 策略模板，由测试校验 |
| `dsh-guardrails/i18n/` | 卡片文案（`zh.json`、`en.json`） |
| `dsh-guardrails/locale/` | **宿主**读的插件元数据：标题、副标题、点开看哪个 `detail` 页面。门禁本身不用它，不要删 |
| `dsh-guardrails/test/` | 单元、契约、命令行与挂载级测试 |
| `dsh-guardrails/tools/` | `check.mjs`（在终端里问一句）、`audit-report.mjs`（离线读取） |
| `design/` | 决策记录：测量数据、被否掉的方案、已知缺口 |
| `CHANGELOG.md` | 版本历史（英文与中文两份） |
| `SECURITY.md` | 支持哪些版本、什么算漏洞、怎么私密报告 |
| `CONTRIBUTING.md` | 改代码的底线、文件地图、加一条规则要动哪些地方 |
| `scripts/` | 维护者工具：审计脱敏、快照/恢复、健康检查。**只留本地（已 gitignore），不属于本仓库** |

之所以有这套工具，是因为审计文件里含命令原文和路径。它在本地做快照与脱敏，再用 Windows DPAPI
加密（绑定当前用户账户）。

## 开发

无构建、无运行时依赖，测试直接跑：

```powershell
npm test   # 依次跑十八个测试文件
```

要用 `node <文件>` 而不是 `node --test`：DSH 沙箱不允许测试运行器派生子进程。机器上没有 `npm`？
`npm test` 只是一串 `node test/<文件>.mjs`，用手边的 `node` 逐个跑即可——细节见
[CONTRIBUTING.md](CONTRIBUTING.md)。

## 已知限制

- **不是沙箱。** 它只看得到工具调用。直接粘贴进对话的文本绕过它；有本机权限的人也能直接改文件。
- **规则基于正则与路径。** `cmd /c`、`powershell -Command`、`Start-Process` 和工具的绝对路径会先剥壳再匹配，
  但变量拼接（`$tool = 'for' + 'mat'`）和 `powershell -EncodedCommand` 仍可能绕开破坏性命令的匹配；
  各层里路径判定（R1）最扎实。
- **间接执行看不见。** `powershell -File x.ps1`、`reg import`、以及在 DSH 之外双击 `.reg` 文件，
  都不经过匹配器（`regedit /s` 因脚本不可见已被按 critical 拒绝）。critical 层管的是命令文本，
  不是脚本或配置单元的内容。
- **审批界面不完全受插件控制。** 弹窗由宿主渲染，而且宿主**故意不给插件**结构化正文的位置；
  插件只能提供标题行。
- **审计只覆盖被拦截的调用。** 没命中规则、或根本没过闸门的调用不会留下记录。记录能证明插件判了什么、
  宿主执行了什么，却不能证明 DSH 之外发生了什么。
- 仅 Windows。

## 卸载

在 Plugins 页面里移除；或者从 profile 的 `dsh.profile.bundles` 和 `dependencies` 里删掉
`@vladimirkuzen/dsh-guardrails`，重启 DSH。已有审计文件不会自动删除；需要的话自行清理。

## 许可证

MIT。

## 致谢

这个插件是在 DeepSeek Harness 里以 agent 协作的方式做出来的：代码、测试与文档由 agent 起草，
方向与验收由维护者定。提交署名、发布决定以及每一次真机验收，仍然由维护者负责。

