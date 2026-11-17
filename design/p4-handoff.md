# P4 交接：开源发布

**用途**：给接手 P4 的会话一个可读起点。P4 不继承 P1/P2/P3 的对话，只继承仓库里的文件。
先读这份，再按需读 `design/p3-handoff.md`、`design/p3-policy-v2.md`、`dsh-guardrails/docs/ARCHITECTURE.md`。
路线图原文在仓库外 `D:\work\DSH-guardrails-DOCS\implementation-plan.md`（§7 是 P4 的原始条目，§6 已按实际落地改写）。

## 0. 现状快照（2026-11-17，P3 收口后）

- 插件版本 **1.5.0**；`main = 82cdcd7`（`v1.5.0` 与 `p3` 都指向它，其后只有一条文档提交 `b726bed`）。
- 测试：18 个文件 **404 条**全过（`dsh-guardrails/package.json` 的 `scripts.test` 逐文件串联）。
- 文档已就位：`README`/`README.zh-CN`、`CHANGELOG` 双语、`docs/{ARCHITECTURE,DSH-API,POLICY,POLICY.zh,DETAIL,DETAIL.zh}.md`、`examples/policy/` 四份模板（有测试保证可用）。
- 仓库根已有：`LICENSE`（MIT，`Copyright (c) 2026 Vlad`）、`.gitignore`、`.gitattributes`。
- 包仍是 `"name": "@vlad/dsh-guardrails"` + `"private": true`，没有发布过，没有 CI。

## 1. 目标与非目标

**目标**：外人拿到仓库，一小时内能装进自己的 DSH、看到一次拦截、改一条自己的规则、知道去哪查为什么被拦。

**非目标**（写进 README 与 P4 交付说明，避免预期错位）：

- 不承诺跨平台。判定依赖 Windows 语义（PowerShell 动词、注册表/服务/计划任务、盘符路径）；macOS/Linux 上不会"凑合能用"，是明确不支持。
- 不做沙箱。它是"在工具调用执行前多问一句"的路障，不是边界（`docs/DSH-API.md` 的"宿主不给插件做的事"）。
- 不引入 LLM、不联网判定。同输入同策略必定同结果。
- 不改引擎语义。P4 是发布工程；引擎改动进 P5 或有独立提案。

## 2. 开源前需要你拍板的四件事

1. **版权署名**：`LICENSE` 现在写 `Copyright (c) 2026 Vlad`。要全名、要加份公司抬头、还是保持现状？
2. **仓库名与包名**：现在 remote 是 `github.com/VladimirKuzen/DSH-guardrails`，包名 `@vlad/dsh-guardrails`。公开时是沿用 `@vlad`，还是换成无 scope 的 `dsh-guardrails`（`private: true` 必须同时去掉）。
3. **`design/` 是否公开**：里面是真实决策与踩坑记录（含本机路径），公开会让"为什么这么判"可查，但也暴露你机器的目录名。建议公开（改成通用路径），因为它是这个项目最有价值的部分之一。
4. **`scripts/` 是否公开**：现在是个人运维脚本（`health-check.cmd`、`redact.bat` 等），依赖本机布局，已在 `.gitignore` 里。建议不公开。

**拍板结果（2026-11-17）**：(1) 保持现状，`Copyright (c) 2026 Vlad`。(2) 保留 `@vlad/dsh-guardrails`——无 scope 的 `dsh-guardrails` 已被占用；仓库先维持私有，随 P4 逐项验证再转公开，私有→公开的过程本身就是 P4 的设计内容。(3) `design/` 公开，路径改成通用占位。(4) `scripts/` 不公开。

## 3. 工作分解

### 3.1 仓库整理

- [x] `LICENSE`（MIT）
- [x] `README.md` / `README.zh-CN.md`（定位、安装、规则表、配置示例、审计、限制、文档地图）
- [x] `CHANGELOG.md` / `CHANGELOG.zh-CN.md`（1.5.0 定版；更早的条目已按版本分节）
- [x] `.gitignore`（`_backup/`、`_scratch/`、`scripts/`、`/audit/`、`node_modules/`、`*.log`）
- [x] `SECURITY.md`：漏洞怎么报（GitHub 私密报告，私有期走同一入口或仓库持有者账户）、支持哪些版本（`1.x`）、"不要用公开 issue 贴绕过细节"
- [x] `CONTRIBUTING.md`：加一条规则要改哪几个文件、必须补哪张测试表、代码注释用英文（弱约束）、测试怎么跑（18 个 `node test/*.mjs`，本机没有 `npm` 时用 bundled node）
- [x] `docs/` 内链自检：`test/docs.test.mjs` 遍历所有被跟踪的 `.md`，逐条解析相对链接，断了就红；同时锁 `i18n` 两份 key 与 `{}` 占位符集合

### 3.2 去个人化

- [x] 已跟踪文件里没有本机绝对路径（P4 复核后，README/design/test 里的真实仓库路径、bundled node 路径、宿主安装路径都已换成占位；`git grep` 可复验）
- [x] `scripts/` 已忽略，`package.json` 的 `files` 白名单不含它
- [x] README 里若出现 `~/.dsh/profiles/desktop/...` 之类的具体 profile，改成 `~/.dsh/profiles/<your-profile>/...`（复核：两版 README 只有 `<profile>` 占位）
- [x] `examples/policy/` 四份模板确认不含真实用户名与真实盘符（`git grep 'C:\\'` 无命中）
- [x] `dsh-guardrails/index.js` 的启动日志里若打印绝对路径，确认只在日志里、不进卡片（复核：`index.js` 不打印日志）

### 3.3 包元数据

- [ ] 决定包名与 scope（见 §2.2），同时去掉 `"private": true`
- [x] `license`、`repository`（后者还没加）、`files` 白名单、`bin`、`exports`、`engines.dsh`
- [ ] `repository` / `homepage` / `bugs` 三个字段（公开前必须填，否则 npm 页是空的）
- [ ] `engines.dsh` 当前是 `">=0.2.0-0"`；宿主是否校验它尚未验证（`docs/DSH-API.md` 里标的是"我们不校验"），公开前要么验证一次、要么在 README 写清"仅在 0.2.x 上测过"
- [ ] 版本规则写进 `CONTRIBUTING.md`：`1.x` 内保持协议兼容（审计字段、`policy.schema.json` 只加不改），破坏性变更升 2.0

### 3.4 CI

- [ ] GitHub Actions：`windows-latest` + 与宿主一致的 Node 主版本，跑 `npm test`（18 个文件串联）
- [x] i18n parity：`i18n/zh.json` 与 `i18n/en.json` 的 key 集合必须相等（现在由 `test/docs.test.mjs` 保证，含占位符集合）
- [ ] `check` CLI 冒烟：`node tools/check.mjs --tool pwsh --args '{"command":"git reset --hard"}'` 期望 exit 2；这条也能当文档里的可复制示例
- [ ] 不做 macOS/Linux job（见非目标）

## 4. P3 遗留的两项（不阻塞发布，但要在 README/CONTRIBUTING 里有位置）

1. **`apply_patch` 的真实参数形状**（`design/p3-policy-v2.md` §11-1）：宿主里补丁到底放在哪个键没确认；自保护侧用"扫所有字符串参数里的 `*** Delete File:` 行"绕开，R1 home 侧仍是文本近似。查清它需要能读到宿主源码的机器。
2. **`observe` 返回 `next()` 的宿主完整放行链路**（§11-2）：mount 级已断言 `kind === 'allow'` 且审计只写 `observed`；宿主里没有专门跑过一条"observe 放行且结果是 allow"的 live 链路。

## 5. 收集箱条目（`design/p4-candidates.md`）的取舍建议

| # | 条目 | 建议 |
|---|---|---|
| 1 | 审计报告"规则级批准率"视图 | **可做**，成本低、公开后对用户有用（"这条规则是不是太宽"），但要先确认 `outcome` 样本足够 |
| 2 | 项目级策略（放宽逐行上报 + 只准收紧开关） | **先不做**：开源用户会需要，但要先有"项目策略"这个真实需求，别提前设计 |
| 3 | 规则变更必须先跑 fixture 才落盘 | **可做**：`examples.test.mjs` 已经是雏形，扩展到 `rule.json` 式的用户规则 |
| 4 | 逐 host 的 fail-open 表 | **可做**：纯文档，公开前正好补一次真实的 profile 级加载验证 |
| 5 | 命令的目标位置语义（`rm -rf .` / `~` / `/` 分档） | **不做**：换血级，属于 P5 |
| 6 | 复合命令按最坏动作选 `facts.kind` | 已实现（P1.9） |
| 7 | 卡片补有界命令头（≤60 码点） | **待定**：需要先知道宿主参数区还会不会二次截断 |

**一条否决仍然有效**：observe 不作为"放宽到 allow"的证据来源（`design/p4-candidates.md` 末尾，含循环论证说明）。

## 6. 风险与约束

- **`policy.json` 是受信输入**。护栏拦得住 agent 改它，拦不住用户手改；坏文件整份忽略并保留上一份好策略，但"拼错的路径静默失效"这类问题只能靠 `check --validate` 与 `status` 线索（已写进 `docs/POLICY.md`）。
- **BOM**：记事本与 Windows PowerShell 5.1 会写 BOM。读入侧已剥，写回侧必须用 `UTF8Encoding($false)`；提交消息与文档同样。
- **`npm` 不在本机 PATH**：所有测试用 bundled node 逐文件跑；CI 里才有 `npm test`。
- **中文只能进 `.md` 与界面文案**（`constraint.weak.local`）：代码注释、标识符、文件名用英文。
- **改插件代码必须重启宿主**，改 `policy.json` 两秒热读；改完核对 `~/.dsh/guardrails/loaded.json` 的 `version` 与 `surface`。

## 7. 验收：一小时内跑起来（公开前自己走一遍）

1. 新读者从 README 的"安装"走到 `loaded.json` 出现 `version: 1.5.0` / `surface: "ok"`。
2. 跑 `examples/policy/minimal-v1.json`：`node tools/check.mjs --policy … --tool pwsh --args '{"command":"git reset --hard"}'` → exit 2 且有理由。
3. 在 DSH 里触发一次真实弹卡（写一个文件到受保护目录）。
4. 用 `POLICY.md` 的三档灰度改一条规则，2 秒后生效。
5. 用 `tools/audit-report.mjs --stats --verify` 看到 `chain ok`。
6. 找到 `docs/DSH-API.md` 的升级核查清单，确认自己知道 DSH 大版本升级后先看哪一行。
7. 读 `CONTRIBUTING.md`，知道加一条规则要碰哪三个文件。

## 8. 建议顺序

1. 先拍 §2 的四件事（署名、包名、`design/` 与 `scripts/` 公开与否）——其余工作都取决于它们。
2. 补 `SECURITY.md` + `CONTRIBUTING.md` + 包元数据三个字段（半天）。
3. 加 CI（含 i18n parity 与 CLI 冒烟）。
4. 按 §7 自己走一遍"一小时"验收，把卡住的地方改 README。
5. 最后再决定收集箱里的 #1/#3/#4 是否进 P4；#5 明确留到 P5。
