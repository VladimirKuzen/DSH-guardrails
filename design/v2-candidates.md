# 2.0 候选（收集箱）

- 状态：**收集箱 v1（2026-11-17）**，不代表承诺、不排期、未实现
- 用途：P4 是发布工程、引擎语义冻结，所以"看到了但不该现在动"的条目收在这里；等 2.0 真正立提案时，从这里挑
- 与 `design/p4-candidates.md` 的关系：那本是 P4 开工前收的；其中 #2/#3/#4/#5 至今没做，按"仍然有效"并入本表，原文件不再单独排期
- 收条目的口径：**只要改动会碰判定结果、verdict 形状或审计字段，就不进 1.x**。1.x 只加协议、不回改语义
- 证据来源：`design/compare-cc-safety-net.md` v2（2026-11-17）与当日实测；编号 `C-` 开头，方便在提案和测试里引用

| # | 条目 | 来源 / 证据 | 级别 | 为什么不在 1.x 做 |
|---|---|---|---|---|
| C-1 | R1 读 `apply_patch` 的补丁文本（今天补丁写 `~/.dsh` 直接放行） | 2026-11-17 23:41 实测：补丁写 `dsh-guardrails\rules.js` → `review R1 ask self` exit 2；写 `.dsh\guardrails\policy.json` → `allow no rule matched` exit 0。compare §4.3 | **高**（真实缺口，不是改进） | 改的是 R1 band 的判定输入。修法二选一：R1 复用 `lib/rules/r1-self.js:64-73` 的 `patchTargets`，或把 `pathOf` 扩成"多路径"；两条都要改 `facts` 形状并加契约用例，属引擎语义 |
| C-2 | 残余风险登记表 `docs/residual-risk-registry.json`（id、边界、受影响档位、对应 fixture、裁决来源） | compare §6.1；现状 8 个 `knownGap` 用例只断言"当前放行"，没有 RR id 可反查 | 中 | 文档本身不改判定，但"每个 `knownGap` 必须反查一条 RR、反向也成立"要进 CI 才防退化，属 2.0 的验收体系 |
| C-3 | 每条规则带 `intent`（`hard_stop` / `use_alternative` / `scope_down` / `manual_only` / `stop_and_explain`） | compare §6.2 | 中 | 改变 verdict 的对外形状（卡片末行、`check --json`）；模型换写法重试的问题要靠它，但归属在引擎 |
| C-4 | 运行时 `degraded` 标志 + 审计 `configFallback` 字段 | compare §6.3；现状 `index.js:232-271` 已做"拒载 + `config-invalid` 审计"，`index.js:189` 的 `degraded` 只表示宿主接口缺失 | 中 | 审计字段是协议；先得定义"哪种降级算降级"（非法字段回落后仍生效？只读回落？），否则字段会变成噪音 |
| C-5 | `check --json` 输出 trace（含"看了但没命中"的规则） | compare §6.5；现状只有 `winner` / `reasons` / `facts` | 低 | 纯增量输出，但 trace 形状一旦上线就是事实协议，得一次定对 |
| C-6 | 命令的目标位置语义（`rm -rf .` / `~` / `/` 分档） | compare §5.3；`design/p4-candidates.md` #5 | 未排期（换血级） | R2 从"模式匹配"改成"命令分析"，等于重写 R2 |
| C-7 | 逐 profile 的 fail-open 表（`web`/`desktop`/`acp`/`headless`/`sdk`） | `design/p4-candidates.md` #4 | 低 | 纯文档，但需要先有一次真实的 profile 级加载验证，否则只能转抄宿主代码 |
| C-8 | 项目级策略（可放宽，但每条放宽逐行上报，另配"只准收紧"开关） | `design/p4-candidates.md` #2；compare §6.4 | 未排期 | 现在只有用户域一份策略，没有第二个作用域，做了没人用 |
| C-9 | 规则变更必须先跑 fixture 才落盘 | `design/p4-candidates.md` #3；compare §6.6 | 未排期 | 属工具链；契约表本身还可能变，闸门先跟着漂 |

## 不在本表里的

- 写命令解析器、`standard/strict/paranoid` 等级、deny-only、12 个 CLI 子命令 + GUI、`rule.json` 双文件配置：`design/compare-cc-safety-net.md` §7 已明确不学，理由是不换血、不造第二套词汇
- 已实现并已验证的条目（如复合命令按最坏动作取 `facts.kind`，P1.9）：不进收集箱，留在各自的发布文档里

## 怎么用这份表

1. **2.0 立项时**先挑 C-1（唯一一条"现在就能复现的漏洞"），再按"改动小、可当场验证"排 C-2 / C-3 / C-4。
2. 每条立项时补三样：**判定在哪一行**、**新契约用例**、**怎么证伪**（一条会从红变绿的断言）。缺任何一样就不算可开工。
3. 这张表只收"想做"，不收"为什么不做"；否决记在各自的比对文档里，不在这里复活。
