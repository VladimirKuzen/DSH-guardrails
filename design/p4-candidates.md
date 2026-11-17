# P4 候选（收集箱）

- 状态：**收集箱 v1（2026-11-16）**，不代表承诺、不排期、未实现
- 用途：把"想到了但不该混进 P3"的条目收在一处，拍板前不动
- P3 本体见 `design/p3-policy-v2.md`；外部参照见 `design/compare-cc-safety-net.md`
- 2026-11-17：表里未做的 #2/#3/#4/#5 已并入 [design/v2-candidates.md](v2-candidates.md)（`C-6`…`C-9`），原表保留以便追溯

| # | 条目 | 来源 | 优先级 | 为什么低 |
|---|---|---|---|---|
| 1 | 审计报告加"规则级批准率"视图（`--by rule --approval-rate`） | 2026-11-16 与用户讨论 observe 语义时提出 | **低** | 只是报告层增强；`requested`/`outcome` 数据已经在盘上，缺的是视图不是能力，手工 `jq` 也能查 |
| 2 | 项目级策略（可放宽，但每条放宽逐行上报；另配"只准收紧"开关） | `design/compare-cc-safety-net.md` §6.4 | 未排期 | 现在只有用户域一份策略，没有第二个作用域，做了也没人用 |
| 3 | 规则变更必须先跑 fixture 才落盘 | `design/compare-cc-safety-net.md` §6.6 | 未排期 | 属工具链；P3 的契约表跑通之前没有落盘闸门可加 |
| 4 | 逐 host（`web`/`desktop`/`acp`/`headless`/`sdk`）的 fail-open 表 | `design/compare-cc-safety-net.md` §6.7 | 未排期 | 纯文档，但需要先有一次真实的 profile 级加载验证 |
| 5 | 命令的目标位置语义（`rm -rf .` / `~` / `/` 分档） | `design/compare-cc-safety-net.md` §5.3 | 未排期 | 等于把 R2 从模式匹配改成命令分析，是换血级工程 |
| 6 | 复合命令按"最坏动作"选 `facts.kind`（今天取第一条动作语句，`Get-ChildItem \| Remove-Item` 记成读取） | `design/p1.8-dry-run.md` §9（P1.8 live 验收时的可读性问题） | **已实现（2026-11-16，P1.9）** | 当时判为换血级；实际改动集中在 `dsh-guardrails/lib/facts.js` 的 `worstActionStatement`，quiet 只接受单语句命令，故 quiet 判定不受影响，契约用例全绿 |
| 7 | 卡片补一段有界命令头（命中语句前 ≤60 码点） | `design/p1.8-dry-run.md` §9 | 未排期 | 需先确认宿主参数区不会再截一次；且与预演重复度高，等预演 live 数据 |

## 记一条否决

- **observe 不作为放宽（ask → allow）的证据来源**。它只回答"会命中几次"，不回答"你上次批准了没有"；而且"ask 改 observe 一周 → 观察到零反对 → 改 allow"是循环论证（不问了，所以没人反对）。放宽的依据只能是既有 `outcome` 记录的批准率 + payload 原文，且仅限可逆操作（见 #1）。记录于 2026-11-16 讨论。
