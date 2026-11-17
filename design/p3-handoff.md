# P3 交接：可修改性与自保护

**用途**：给“新会话”一个可读的起点。P3 不继承 P1/P2 的对话上下文，只继承仓库里的文件。
读完这份，再看 `design/p1.6-windows-critical.md`、`design/p2-audit-v2.md`、`design/p1.7-workspace-quiet.md`
的对应小节。路线图原文在仓库外的
`D:\work\DSH-guardrails-DOCS\implementation-plan.md`（§6 是 P3 的原始条目）。

## 0. 现状快照（2026-11-17，P3 收口后）

- 插件版本 **1.5.0**；`main = 82cdcd7`（`v1.5.0` 与 `p3` 都指向它）；工作树干净。
- tag：`v1.1.0-baseline`、`p1-readability`、`p1.6`、`v1.2.2`、`v1.3.2`、`v1.4.0`、`p2`、
  `p3-engine`（引擎 v2 那一步）、`v1.5.0` + `p3`（收口，版本线与里程碑线并行，已推的 tag 不改名不覆盖）。
- 测试：17 个文件 **400 条**全过（rules 34 / facts 29 / describe 17 / replay 3 / critical 15 /
  audit 11 / quiet 19 / finalize 9 / dry-run 10 / redact 9 / self-protect 22 / policy-schema 10 /
  engine-v2 19 / contract 73 / examples 4 / cli 78 / smoke 38）。
- 判定入口：`dsh-guardrails/index.js`（`tools/pre-execute`）；`rules.js` 按引擎版本分派，
  v1 逐条短路、v2 收集后按 rank 取赢家。带序：R3 → R1 home → R1 self → R2 critical →
  R2 destructive → `entries`，之后是 quiet 与预演。
- 审计：`lib/audit/v2.js`（事件流 + payload + 哈希链；`observed` 事件、脱敏、密钥不写哈希）。
- 卡片文案：`lib/facts.js` + `lib/describe.js` + `i18n/{zh,en}.json`。
- 文档：`dsh-guardrails/docs/` 下的 `ARCHITECTURE` / `DSH-API` / `POLICY`（双语）/ `DETAIL`（双语）。
- 未收口项见本文 §7 与 `design/p3-policy-v2.md` §11（`apply_patch` 参数形状、`observe` 的宿主放行流程）。

## 1. 必须保持的不变量

1. **顺序**：R3（密钥）→ R1（DSH 自身目录）→ R2c（critical 硬停）→ R2（破坏性）。改任何一条都要先跑
   `test/rules.test.mjs` 里的顺序测试（P3 的“显式优先级”会动到这里，必须保留可断言的确定性）。
2. `readOnlyDiagnostic` 必须在 R2 模式匹配**之前**生效，否则 `bcdedit /enum`、`diskpart list disk` 这类只读排障会被误拦。
3. 只有 critical 层 fail-closed（`rules.critical.failClosed`，默认 true）；其余层判定异常时放行，这是刻意取舍。
4. R3 命中 shell 命令一律 **deny 且不弹卡**——卡片会回显命令原文，密钥就泄了。文件写入仍走 ask。
5. quiet 只认“单文件、单语句、无递归、无通配符、已解析绝对路径、位于 roots 与 paths 下层”；
   目录一律回到 ask（`facts.count` 对目录为 `undefined`）。
6. 审计哈希链：`canonicalJson` 必须与 `JSON.stringify` 对 `undefined` 的处理一致，否则写盘再读回校验失败（1.3.1 的教训）。
7. v1 审计格式保持只读兼容（`audit.format: "v1"` 可回退），不要删旧记录。
8. 错误信息面向模型用英文（`reason`），卡片文案跟随界面语言（`displayReason`），两者不要混。

## 2. P3 的目标（来自路线图 §6）

| 子项 | 内容 |
|---|---|
| 策略 v2 | 向后兼容 v1；新增 `mode: "observe"`、显式优先级 `block > review > allow`、`reasons[]`、按工具 + `when` 条件 |
| 自保护 | 插件源码目录纳入受保护根；`policy.json` 与 `i18n/` 允许读、改必须审批；文档说明这不是沙箱 |
| CLI 与契约 | `check --tool … --args …`，退出码 0/2/3；表驱动契约测试覆盖默认规则与已知绕过；`policy.schema.json` + 启动校验 |

## 3. 已知边界与陷阱（P3 最容易踩）

- **自保护的边界**：R1 目前只管 `~/.dsh`、`~/.agents`；插件源码在 `D:\...\guardrails\dsh-guardrails`，agent 可直接改写
  `rules.js`，重启即生效。自保护要加的是“工具调用层”的拦截——它拦不住用户本机直接编辑，也不拦插件进程内的写。
  写文档时必须说清这一点，别把“受保护”说成“不可改”。
- **不要用 `process.cwd()` 当工作目录**：那是宿主安装目录。`resolveCwd` 只认 `session.cwd` 与 shell 的 `workdir`。
- **审计 target 按码点截断**，不要退回字节截断（会切坏中文）。
- **confined shell 删 Medium 完整性文件会失败**（`diagnose-windows-sandbox-acl` 判 `NOT_THIS_CLASS` 时不要改 ACL）。
- **`npm` 不在 PATH**：测试用 bundled node 逐文件跑
  `C:\Users\<you>\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`。
- **中文字符串不要进 `Set-Content`**：一次批量替换把两份 README 写成了乱码，已从 git 还原；中文改动走编辑工具。
- **改插件代码必须重启 DSH**，并用 `~/.dsh/guardrails/loaded.json` 的 `version` + mtime 核对（pid 不可信）。
- **删 `audit/v2` 目录**会让新链以非 `genesis` 开头；要轮换就让用户手动删，或先停插件。
- **Windows-only**，不要引新依赖，不要承诺跨平台。

## 4. 测试与 live 流程

```powershell
$node = "C:\Users\<you>\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
cd dsh-guardrails
& $node test/rules.test.mjs      # 顺序：rules → facts → describe → replay → critical → audit → quiet → plugin.smoke
& $node test/plugin.smoke.mjs
```

live 验收最少三条：① `Get-Date` 无卡放行；② critical（如 `cmd /c "reg delete HKLM\SYSTEM\X /f"`）无卡拒绝；
③ 一条普通删除弹卡。随后 `node tools/audit-report.mjs --verify` 必须输出 `chain ok`。

## 5. 交付习惯

- R1：动 `~/.dsh`、插件目录、profile 前先备份到当前工作区 `_backup/<时间戳>/`，再 dry-run；一次只做一类操作。
- 注释：文件头中英双语，其余英文；给用户看的文案与 `.md`（尤其计划类）用中文。
- 每个阶段一个小提交，消息写清“改了什么、为什么”；tag 用语义化版本或 `p<阶段>`。
- 验证不了的直说“未验证”，不要用“应该没问题”糊过去。

## 6. 建议的第一步（给新会话）

先只读：`design/p2-audit-v2.md` 的事件模型 + `lib/rules/kit.js` 的规则表 + `index.js` 的三个监听。
然后给一份 P3 设计草案（策略 v2 的字段形状、优先级怎么实现、自保护放在哪一层、`check` 的退出码语义），
**不要先改代码**——P3 会动到判定顺序与审计契约，设计错一次要回滚两次。

**2026-11-17 更新：本文已过期。** P3 已按 `design/p3-policy-v2.md` 完成并收口到 1.5.0
（五步的落地状态见该文 §7.1–§7.6，live 验收证据见各节末尾）；接手时先读该文的 §7.6 与
`dsh-guardrails/docs/ARCHITECTURE.md`。
