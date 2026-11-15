# 更新日志

[English](CHANGELOG.md) | **中文**

本护栏的显著变更，最新在前。版本号跟随 `dsh-guardrails/package.json`。

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
