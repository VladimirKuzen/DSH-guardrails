# 更新日志

[English](CHANGELOG.md) | **中文**

本护栏的显著变更，最新在前。版本号跟随 `dsh-guardrails/package.json`。

## [未发布]

- 仓库只保留一份 README：删除插件级 README，根 README 统一覆盖安装、规则与结构；包的 `files` 白名单不再包含它。
- 设计文档从 `docs/` 移到 `design/`，根目录不再与插件的 `dsh-guardrails/docs/`（插件详情页数据源）重名。
- 增加 MIT 许可证。
- 文件头中英双语；内联注释只用英文。

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
