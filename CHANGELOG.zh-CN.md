# 更新日志

[English](CHANGELOG.md) | **中文**

本护栏的显著变更，最新在前。版本号跟随 `dsh-guardrails/package.json`。

## [未发布]

- 发布配套文档：[SECURITY.md](SECURITY.md) 写明支持哪些版本（`1.x`；仅 Windows，"跨平台不工作"不算漏洞）、
  什么算绕过、什么是已记录的边界，以及漏洞走 GitHub 私密报告而不是公开 issue。
  [CONTRIBUTING.md](CONTRIBUTING.md) 写了改代码的底线、文件地图、加一条规则的六步、
  以及 `policy.schema.json` 的兼容规则。
- 新增 `test/docs.test.mjs`：`i18n/en.json` 与 `i18n/zh.json` 的 key 集合、`{占位符}` 集合必须一致；
  被跟踪的 Markdown 里每条相对链接都必须能解析。链接检查还断言"至少扫到多少条"，
  这样走查逻辑悄悄匹配不到东西时会失败，而不是假通过。
- 已跟踪文件里不再有本机绝对路径：README 的 `quiet` 示例、`design/` 里的记录、三个测试文件都换成
  `D:\work\...`、`%USERPROFILE%\...`、`%LOCALAPPDATA%\...` 占位。`test/self-protect.test.mjs`
  改为从 checkout 推导工作区（`pluginRoot()` 的父目录），不再写死路径，所以这条用例不依赖仓库放在哪。
- `README.md` / `README.zh-CN.md` 不再自称"1.0 之前"，开发一节的测试文件数改为与事实一致：18 个文件、
  404 条。
- 新增 `design/p4-release.md`：记录四个拍板、分批落地、历史重写，以及每条结论的证据。
- 包元数据：`repository`（带 `"directory": "dsh-guardrails"`，因为包在子目录里）、`homepage`、`bugs`
  指向 GitHub 仓库。`private` 保留到仓库公开，所以现在还发布不了。README 写明实际验证过的宿主版本：
  DSH desktop `0.2.2-rc.1`。
- `dsh-guardrails/` 现在自带 `README.md` 与 `LICENSE`：npm 只收包目录里的文件，之前的 tarball 既没有 npm
  页面要显示的 readme，也没有许可证正文。现在 `pnpm pack` 为 40 个条目，不含 `test/` 与 `design/`。
- CI：`.github/workflows/test.yml` 在 `windows-latest` + Node 24 上跑全套测试与 `check` 冒烟
  （`git reset --hard` 必须退出 2）。两个 action 钉 commit SHA；包零依赖，所以没有安装步骤。
- 首次 CI 运行全绿（2026-11-17），顺带说明 `npm test` 在真实 npm 下的结果与本机自带 Node 跑出来一致。
- 安装一节现在能在干净机器上照做：以 `git clone` 开头，`pnpm install` 一步改为调用 DSH 自带的 pnpm
  （`~/.dsh/dsh-runtimes/*/dependencies/pnpm`）——裸装 Windows 上 `pnpm` 与 `node` 都不在 `PATH` 里。

## [1.5.1] — 2026-11-18

- R1 现在会读 `apply_patch` 文本里的目标——`*** Add|Update|Delete File:` 头与 `*** Move to:` 目的地——并像
  `write` 同一路径那样对 `~/.dsh`、`~/.agents` 求值。过去改写 `~/.dsh/guardrails/policy.json` 的补丁返回
  `allow`，现在会弹卡。这是有意的收紧：v1 策略只会多一次弹卡，不会多出一条静默放行。
- 自保护也读 `*** Move to:`。此前只扫文件头，所以"只是把文件改名移进插件源码"的补丁看不到。
- 契约表剩七个 `knownGap`（`gap-apply-patch-delete-dsh` 改为普通用例）；18 个文件共 413 条断言。

## [1.5.0] — 2026-11-17

- 补上一套文档：[docs/POLICY.zh.md](dsh-guardrails/docs/POLICY.zh.md) 讲档位、`entries`、三步放宽法与模板；
  [docs/ARCHITECTURE.md](dsh-guardrails/docs/ARCHITECTURE.md) 是文件地图、一次调用的路径与状态存放位置；
  [docs/DSH-API.md](dsh-guardrails/docs/DSH-API.md) 列出它依赖的每个宿主接口、哪个接口变了会怎样、以及升级
  DSH 后的五步核查。`README.zh-CN.md` 按 v2 重写，开头加了文档地图；仓库结构一节补上 `lib/`、`docs/`、
  `i18n/`、`examples/` 与 `locale/`（最后这个是宿主读的插件元数据，别删）。
- `dsh-guardrails/examples/policy/` 下的四份模板（`minimal-v1`、`observe-first`、`tighten`、
  `relax-with-guard`）随包发布，并由 `test/examples.test.mjs` 校验，不会与 schema 漂移。
- `loaded.json` 记录 `surface: "ok" | "degraded"`。缺 `ctx.on` 时挂载写入 degraded、记一次错误并直接返回，
  不再假装挂载成功——宿主接口变了会当场显形，而不是看起来一切正常。
- `cwdUnder` 条目改为从 session header 取工作区（`session.header.cwd`；`meta.cwd` 与 shell 调用自带的
  `workdir` 是兜底）。原先读 `session.cwd`，而本宿主从不填它，等于这类条目静默失效。策略里有
  `cwdUnder` 条目却拿不到 cwd 时，会写一条 `config-invalid` 记录说明，而不是继续沉默。
- `config-invalid` 审计记录会保留 `reason` 与 `detail`：写入器的字段白名单把它们丢了，于是记录只说
  "出了问题"、从不说"出了什么问题"。
- 卡片会跟随变量里的字面量：`$p = 'D:\work\a.txt'; Remove-Item $p` 现在直接写出 `D:\work\a.txt`
  （也不再要求预演），不再报"目标未知"。`$env:` 的值仍然不替它猜——它没写在命令里。
- 工作区静默挪到 `rules.quiet`（旧的 `rules.destructive.workspaceQuiet` 仍然有效，两处都写会被拒绝，
  免得"哪份生效"靠猜）：它决定的是要不要弹卡，不是破坏性匹配器的属性。命中同一次调用的 `observe`
  条目不再把静默关掉——更弱的命中只进 `reasons` 留痕，不构成否决。
- R1 自保护（`rules.selfProtect`）：写入、或带写动词的 shell 命令落在插件自身目录（以及 `paths` 里追加的根）
  时先弹卡。`apply_patch` 也被覆盖——它没有路径参数，从补丁文本里的 `*** Update File:` 行读目标。
  这个开关只接受 `ask` / `deny`：一个能被它保护的文件关掉的开关不算护栏。它抬高的是“用工具改门禁”的成本，
  不是沙箱——手工编辑、别的进程、插件内部的 `fs` 写都绕得过去。
- 策略文件在合并前先按 `policy.schema.json` 校验：未知键（拼写错）直接拒绝；`version` 大于 2 一律拒绝；
  校验失败的文件不被采用，上一份好策略继续生效，并留一条 `config-invalid` 审计——而不是悄悄放松。
- 策略 schema 进包（`files`），装好的副本也能校验。
- 描述不清的破坏性命令可选先预演（`rules.destructive.dryRun`，默认关闭）：目标由变量决定、命令很长、
  或连着多处破坏性语句时，第一次尝试不弹卡而是拒绝并要求先用只读命令列出确切路径；同一会话、同一形状的
  第二次尝试照常弹卡，正文多一行“首次尝试已要求预演”。这是“推一把”：重试即放行，护栏也判断不出清单是否真跑过。
- 卡片改为说命令里**最坏的那个动作**，而不是识别到的第一个：`New-Item … ; Remove-Item …` 读作“删除”，
  不再显示“新建目录”。目标由变量决定时明确写出来（“目标由变量决定”，预演之后写“见上面的只读清单”），
  目标段不再整段消失。
- 判定引擎 v2（`"version": 2`）：命中的规则不再逐条短路，而是先全部收集、按 `deny` > `ask` > `observe` > `allow`
  排序、取一个赢家；`version: 1` 的文件仍走老路径，行为不变。
- `observe` 只记录不拦不弹卡（`event: "observed"`）；`allow` 放行并记 `event: "allowed"`。两者只在 `version: 2`
  下存在；`version: 1` 里 `observe` 加载即拒、`allow` 仍被当作 `ask`。
- 自定义条目 `entries`：工具 + 条件（`cwdUnder` / `targetUnder` / `commandMatches`，须同时成立）+ 处置。
  它与内置规则一起排序，所以 `entries.deny` 能把降级过的块重新收紧，而 `entries.allow` 永远盖不过内置命中。
  卡片用中文说人话，审计里记 `rule: "E"` 与 `entryId`，全部命中在 `reasons[]`（最多 8 条）。
- 密钥只要在调用里出现过一次，即使排序后是更严的规则赢了，payload 仍按 R3 的形状处理（只留哈希，不存原文）。
- `selfProtect` 在 `version: 2` 下接受 `observe`，作为开发期临时约定：改护栏自身源码不弹卡，改为记 `observed`。
  `off` 与 `allow` 仍被拒绝——能被受保护文件关掉的开关不算护栏——且这不是可以随发布带出去的档位。
- shell 里写到受保护路径时，即使路径是通过变量转手、或写动词在后面的语句，也能命中：原先"同一语句"的判定
  漏掉了 2026-11-17 两次真实的 `policy.json` 写入（审计里一条记录都没有，只有沙箱审批）。`WriteAllText` 一类
  也补进了写动词。
- 受保护路径只有在它是**写动词的实参**时才计数：判定按语句解析，找出每个写动词并解析它自己的实参
  （字面路径，或命令里更早赋给变量的路径）。只是出现在命令里的路径不再算目标，因此
  `& "…\.dsh\…\node.exe" x.mjs; Set-Content out.txt` 与 `Get-Content .dsh\…; Set-Content $env:TEMP\out`
  都不再弹卡，卡片也不再拿程序当被写的对象（2026-11-17 有 5 张这样的卡）。产生它们的 ±400 字符窗口已删除。

- `dsh-guardrails check`（也可 `node tools/check.mjs`）用退出码回答“这次调用会不会被拦”：`0` 放行、
  `2` 会弹卡、`3` 拒绝、`1` 用法或策略错误；走的是宿主同一个引擎和同一段静默判定。`--args -` 从标准输入
  读参数（PowerShell 会弄坏内联 JSON），`--cwd` 设定相对路径基准，`--json` 输出赢家与 `reasons[]`。
  不写审计：它只是提问，不是执行。
- “工作区静默放行”的判定挪进 `lib/finalize.js`，宿主、契约 runner 与 CLI 共用，三处不会再各写一遍而漂移。
- `test/engine-v2.test.mjs` 原先没接进 `npm test` 的测试链，现已接上；CLI 作为第二个 runner 重放整张契约表。
- 密钥不再留哈希：低熵密钥（`password=hunter2`）的哈希就是一个可离线爆破的校验值，所以密钥记录现在只写
  `payloadBytes`。`observe` 下先把命中片段换成 `<redacted:标签>` 再落盘，落盘前复扫仍有命中就整条不写，
  `redacted` 记下被替换的形状（`lib/redact.js`、`test/redact.test.mjs`）。
- `reasonsTruncated` 标记“`reasons[]` 在第 8 条被截断”，读者因此分得清“只命中一条”和“命中了十条”。

## [1.4.0] - 2026-11-15

- 可选的工作区静默（`rules.destructive.workspaceQuiet`，默认关闭）：shell 调用只删除或移动一个目标、
  不带 `-Recurse`、不含通配符、路径是绝对路径且位于 `roots` 之一与 `paths` 之一的下层时，不再弹卡。
  满足上述条件时 `-Force` 也允许。R1、R3 与 critical 层完全不受影响，其余形状照常弹卡。
- 静默放行写成 `allowed` 事件（带 `quiet: "workspace"` 与 payload），所以审计仍然回答得了
  “哪些操作没问就放行了”；v1 模式下也会记 `decision: "allowed"`。
- 若会话 cwd 已知且不在 `roots` 下，quiet 整体关闭并写一条 `config-invalid` 记录；拿不到 cwd 时
  跳过这层交叉验证，只按配置的绝对 `roots` 判断。

## [1.3.2] - 2026-11-15

- 审计记录新增 `cwd` 与 `cwdSource`（`session`、`tool` 或 `null`）：会话有工作目录时记会话目录，
  否则记 shell 工具显式传入的 `workdir`。刻意不取宿主进程目录——那是安装目录，不是工作区。

## [1.3.1] - 2026-11-15

- 修复哈希链：`canonicalJson` 现在与 `JSON.stringify` 对 undefined 的处理一致。`facts` 里 `severity` 为空时，
  记录写盘再读回不再导致校验失败。第一次 live 运行暴露了这个问题——1.3.0 写下的记录 `--verify` 会失败，应轮换。
- 新增回归测试：带 undefined 字段的记录经 JSON 往返后仍能通过校验。

## [1.3.0] - 2026-11-15

- 审计改为事件流（`audit/v2/`）：闸门处写 `requested`，审批服务接手时写 `delivered`，用户或护栏作出决定时写
  `outcome`，批准后真正执行完写 `executed`。旧的单文件日志仍可读；`audit.format: "v1"` 可退回旧格式。
- 命令原文落在 `payload/`，"当时到底执行了什么"事后可查；密钥只留 SHA-256。target 按 Unicode 码点截断，
  不再按字节截断。
- 记录用哈希链串联（`chain.json` + `prevHash`）；`tools/audit-report.mjs --verify` 能发现被编辑或截断的行，
  `--stats` / `--show-payload` 可离线读取。
- 仓库只保留一份 README：删除插件级 README，根 README 统一覆盖安装、规则与结构；包的 `files` 白名单不再包含它。
- 设计文档从 `docs/` 移到 `design/`，根目录不再与插件的 `dsh-guardrails/docs/`（插件详情页数据源）重名。
- 增加 MIT 许可证；文件头中英双语，内联注释只用英文。

## [1.2.3] - 2026-11-15

- 规则拆分为 `dsh-guardrails/lib/rules/` 下的模块（`kit.js`、`r1-home.js`、`r2-destructive.js`、`r3-secrets.js`）；
  `rules.js` 只保留有序调度与 critical 兜底。行为不变。
- 新增顺序测试，锁定 R3 → R1 → R2 critical → R2 破坏性操作的判定顺序。

## [1.2.2] - 2026-11-15

- 目标只能看到一部分时，卡片给出提示：`reg import` / `load` / `restore` 只显示脚本文件、内容不可见；注册表通配符路径提示影响范围未知。

## [1.2.1] - 2026-11-15

- 注册表卡片的目标改为注册表键本身，不再显示 `\v` 这类参数。
- 可逆性按动词区分：`reg add` 显示"恢复方式待评估"，`reg delete` / `reg import` 仍为不可恢复。

## [1.2.0] - 2026-11-15

- 新增 critical 层（severity 为 `critical`），直接拒绝、不弹卡：格式化/分区磁盘、`diskpart /s`、启动配置写入、删除 `HKLM\SYSTEM` 或 `HKLM\SAM`、写/删/移动 `%SystemRoot%` 或 `%ProgramFiles%` 下的内容、`takeown` / `icacls` 指向这些目录。
- 匹配前先剥壳：`cmd /c`、`powershell -Command`、`Start-Process` 和工具绝对路径；`regedit /s` 因脚本不可见按 critical 处理。
- `rules.critical.failClosed`（默认 `true`）：判定抛异常时，看起来像 critical 的调用直接拒绝、不弹卡，而不是放行。
- R2 扩展到注册表写入、服务创建/配置、计划任务、防火墙与防护设置、`chkdsk /f`、`dism /remove-*`、`sfc /scannow`。

## [1.1.0] - 2026-11-14

- 审批卡片改为"收集事实 + 本地化文案（zh / en）"，不再由每条规则内联一个字符串。
- 审计记录 critical 命中的 severity；心跳版本从 `package.json` 读取。
