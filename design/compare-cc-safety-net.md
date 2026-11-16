# 横向对照：cc-safety-net 与本项目

- 状态：**参考材料 v1（2026-11-16）**，只读调研
- 用途：给 P3（`design/p3-policy-v2.md`）拍板时的一份外部参照——不是要抄谁，是先把"同一块地别人怎么盖"看清楚
- 对象：https://github.com/kenryu42/cc-safety-net，npm `cc-safety-net` v2.7.13，MIT，Node ≥22
- 来源：**只有官方文档与 npm 元数据**。本机 pwsh 的 TLS 出口不可用（`curl.exe` 报 `schannel: ... SEC_E_NO_CREDENTIALS`，`Invoke-WebRequest` 报"基础连接已经关闭"），拉不到它的 `dist/`，所以**没有读过一行实现源码**。下文中凡是描述"它怎么实现"的地方，依据都是它自己写的文档，可能比代码乐观
- 日期：外部信息截至 2026-11-16；该包迭代快（`v2.7.x`），引用具体行为时标明出处页面

---

## 1. 它是什么

一句话：**一个只做 deny 的 `tools/pre-execute` 护栏，核心是一个本地命令行解析器。**

- 覆盖 16 个 agent，npm 包里带 DSH 适配：`"dsh": { "bundle": { "patch": "./dist/deepseek-harness/cordis.patch.yml" } }`
- DSH 安装方式：`npx -y cc-safety-net@latest install --deepseek-harness`，装进 `web` 与 `desktop` 两个 profile 的 plugin bundle，需要 pnpm；`acp`/`headless`/`sdk` 等 profile 不覆盖
- DSH 侧读法：`bash` 走 POSIX 分析器、`pwsh` 走 PowerShell 分析器、文件/搜索工具走路径与密钥检查
- 它自己的定位是"命令层"：文档明确说 **不是沙箱**，无网络层，symlink 的 TOCTOU 关不掉

对我们最重要的一条实现事实，出自它的 DSH 页面：

> runs the guard after every other `tools/pre-execute` listener, including approvals and Auto review

也就是说，**它把自己排在我们后面**。第 4 节展开。

---

## 2. 它的引擎：七个阶段，顺序即承诺

`docs/guides/how-it-works.md` 给的是固定顺序，不是"大概先做这个"：

```
① 有界输入抽取（超限直接拒）
② 单次解析（结果复用；超预算拒）
③ policy.json 自保护   ← 在 ⑤ 之前
④ .git 元数据保护      ← 在 ⑤ 之前
⑤ 配置加载
⑥ 敏感路径
⑦ 破坏性命令分析（段、包装器/解释器解包）
```

两件事值得记下来：

1. **③④ 跑在配置加载之前**，因此没有任何一份 `policy.json` 能削弱它们。我们 P3 草案把自保护放在同一个闸门、且 R1 不看开关，结论相同，但没把"阶段编号"写成结构性约束。
2. **分析失败一律拒**（fail closed），且失败本身有 id（`analysis.failed-closed`、`analysis.recursion-limit`、`cwd.session-unusable` 等）。我们的对应物是 `rules.js:41-56` 的 `criticalFallback`，但只在 critical 命中的前提下兜底。

它能解析的深度（同页面）：`sh -c`/`bash -c`/`sudo`/`env`/`python -c`/`node -e` 解包最深 10 层，更深直接拒；同命令内跟 `cd`；shell 函数按调用点分析；heredoc 区分"数据"与"程序"；磁盘上被调用的 shell 脚本会读，报错定位到 `deploy.sh:3: `；PowerShell `.ps1/.psm1` 和 `cmd /c` 各有保守子集读取器。

---

## 3. 重合在哪

| 维度 | cc-safety-net | 我们（dsh-guardrails 1.4.0） |
|---|---|---|
| 挂载 | `tools/pre-execute`，排最后 | `dsh-guardrails/index.js:277`，同一个钩子 |
| 决策集 | 只有 deny / allow | deny / ask / observe |
| 规则形态 | 语法解析 + 规则库 | 正则模式数组 |
| 规则 id | `git.reset-hard`、`rm.recursive-force-root-or-home`、`guard.policy-config` | `R1` / `R2` / `R3`（加 `category`/`label`） |
| 不可关层 | 10 条 catastrophic + `guard.*` | `critical` 层（`lib/critical.js`）+ R3 |
| 策略文件 | `policy.json` + `rule.json` 两份，另可项目级 | 单份 `policy.json` |
| 审计 | JSONL 按项目/月分文件 | JSONL 单文件（`design/p2-audit-v2.md`） |
| 自保护 | 有：`policy.json` 不可写、`policy apply` 不可跑 | P3 才做 |
| 可解释性 | `explain --json`，可回放 trace | 无 |
| 交付面 | 12 个 CLI 子命令 + GUI 看板 + 库 API | 一个报告脚本 `tools/audit-report.mjs` |

**重合的实质**：都承认同一批残余风险（动态拼接、解释器、脚本文件体），都选择"失败就往严了走"，都拒绝用 LLM 判定。差别不在态度，在**工程量**：它的规则是解析出来的，我们的规则是匹配出来的。

我们的规则表在 `dsh-guardrails/lib/rules/kit.js`：

| 常量 | 行 | 内容 |
|---|---|---|
| `DEFAULT_DESTRUCTIVE` | `:17-47` | 30 条正则，Windows 系统管理动词为主 |
| `DEFAULT_SECRETS` | `:50-69` | 9 条密钥形状 |
| `PATH_TOOLS` | `:85` | `write` / `edit` / `create_file` / `apply_patch` |
| `SHELL_TOOLS` | `:88` | `pwsh` / `bash` |

---

## 4. 三处会打架的地方（不是重合，是冲突）

### 4.1 它排在审批之后

用户在我们的卡片上点了"批准"，它仍可能再 deny 一次。澄清一下这不叫双保险：DSH 的 ask 是原生能力，它的设计前提是宿主**没有**审批（Claude Code 那条路径：标准档下两个 denial 会变成 permission prompt）。两个装一起，用户会看到"批准了又被拦"，且被拦的理由来自另一套词汇（level / rule id），没法对照我们的审计。

### 4.2 静默裸奔，双方都有

它的 DSH 说明写得很直白：bundle 加载失败**只告警**，那个 profile 就当没装；`doctor` 读磁盘 manifest 不读运行时；Desktop 崩溃恢复会禁用第三方 bundle。我们的同类问题在 `dsh-guardrails/index.js:163-182`（`loadPolicy` 静默吞解析失败）。两个护栏叠在一起，最大的害处不是漏，而是**"我以为有保护"更难判断**。

### 4.3 它盖不到我们真正的洞

- PTC 模式的 `run_code` 与 `terminal_send` 不覆盖
- 插件自带的 shell 工具默认不被解析（例：`dsh-ops` 的 `ops_bash` 跑 `git reset --hard` 直接放行），必须在 `rule.json` 的 `command_tools` 里声明；**只有 DSH 会向 agent 提示一次**这个缺口
- 这正是我们 P3 自保护想补的 `apply_patch` 同类缺口（`kit.js:109-115` 的 `pathOf` 拿不到 patch 文本里的路径）

---

## 5. 双向缺口：两边的知识几乎不重叠

拿它的 [blocked-commands 表](https://ccsafetynet.com/docs/reference/blocked-commands.md) 逐行对我们的 `kit.js:17-47`：

### 5.1 它拦、我们不拦（按对我们的威胁排序）

| 类 | 例 | 我们的现状 |
|---|---|---|
| 目标位置语义 | `rm -rf .` vs `rm -rf ~` vs `rm -rf /` 分档 | 动词命中即 ask，不区分目标（位置语义只在 critical 层与 R1 里出现） |
| git 破坏性 | `git restore`、`git checkout -- <path>`、`git switch --discard-changes`、`git reset --merge`、`git branch -D`、`git stash drop/clear`、`git tag -d`、`git reflog delete`、`git push --delete/--mirror`、`git rm -f` | 只有 `reset --hard` / `clean -f` / `push --force` 三条 |
| 磁盘 | `dd of=/dev/...`、`mkfs.*`、`shred -u`、`wipefs`、`sgdisk`、`parted mklabel` | 只有 `diskpart` / `format` / `format-volume` / `chkdsk` / `dism` / `sfc` |
| 删除的变体 | `find . -delete`、`find -exec rm -rf`、`rsync --delete`、`xargs rm -rf`、`parallel`、`awk '{system($0)}'` | 全无 |
| 下载即执行 | `curl ... \| bash`、`eval "$(curl ...)"`、`bash -c "$CMD"` | 全无 |
| 解释器自删 | `python -c "shutil.rmtree('/')"`、`node -e "rmSync(homedir())"` | 全无 |
| `.git` 元数据 | `rm -rf .git`、`mv .git`、写 `.git/hooks/*` | 只有 R1 覆盖 `~/.dsh`，不覆盖工作区的 `.git` |
| Windows 嵌套 | `cmd /c rmdir /s /q C:\`、`pwsh -EncodedCommand`、`pwsh -File x.ps1` | 全无（我们只剥一层 `pwsh`/`bash` 的 command 文本） |
| 敏感路径 | 读 `.env`、`~/.ssh/*`（按**路径名**拦） | 只按**内容形状**拦（`DEFAULT_SECRETS`），`cat .env` 不拦 |
| 命名空间提权 | `unshare -r` | 无 |

### 5.2 我们拦、它不拦（Windows 系统侧）

`reg delete`（尤其 `hklm\system`）、`reg add/import`、`regedit /s`、`sc create/delete/config`、`schtasks /create /change /delete`、`takeown`、`icacls /grant|/deny`、`wmic ... delete`、`net user /delete`、`netsh advfirewall set/reset`、`bcdedit`、`bootrec`、`vssadmin delete`、`wbadmin delete`、`reagentc`、`set-mppreference`、`chkdsk /f|/r`、`dism /cleanup-image`、`sfc /scannow`。

它的磁盘表是 POSIX 的（`diskutil`/`wipefs`/`sgdisk`/`parted`），Windows 侧只覆盖 cmd 的 `rmdir /s /q` 与 PowerShell 的 `Remove-Item -Recurse -Force`；**注册表、服务、计划任务、组策略、启动配置它基本不碰**。

### 5.3 结论

两边是**互补的地方知识**：它是"POSIX 开发者工作流 + 目标位置语义"，我们（P1.6 起）是"Windows 系统管理动词 + 不可恢复写入"。交集只有 `git reset --hard` / `git clean -f` / `git push --force` / `format` / `diskpart` 这一小撮。

这也解释了为什么"抄它的表"不划算：那张表一半的命令在 Windows 上根本跑不起来，另一半（git/rm 变体）要补，得先有**目标位置语义**，而那等于把 R2 从"模式匹配"改成"命令分析"——是 P4 的活，不是 P3 的。

---

## 6. 值得学的七条

按"本金 / 收益"排。第 1 条是唯一可以**不碰代码**就落地的。

### 6.1 残余风险登记表（最该抄）

`docs/residual-risk-registry.json` 是它的文档里最不像营销材料的东西：15 条 RR 家族，每条一个 schema：

```json
{ "id": "RR-13",
  "title": "Live Rulebook Files Lose Edit-Pending Enforcement",
  "boundary": "live-rulebook-edit-pending-loss",
  "affected_modes": ["standard", "strict", "paranoid"],
  "strict_fixture": null,
  "adjudication": { "kind": "design", "date": "2026-08-28",
                    "sources": ["TEAM-POLICY-DESIGN.md live-loading", "...accepted residuals"] } }
```

一格里回答四个问题：**边界是什么**、**哪几档模式受影响**、**用哪个测试钉住**（`strict_fixture`）、**为什么接受**（`legacy` = 历史如此，`design` = 主动选择，附来源文档）。

我们的现状：P3 `§9` 是 17 条风险表，`§3.4` 是"自保护拦不住什么"。**那是同一件事的两半，一半散文一半表格，没有 id、没有对应 fixture、没有裁决记录。** 合成 `docs/residual-risk-registry.json` 是这次调研里性价比最高的产出，且立刻能验证：`knownGap` 的契约用例必须能反查到一条 RR。

### 6.2 每条规则带 `intent`

它的拦截文案末行不是"已拦截"，而是按 `intent` 给下一步：

| intent | 告诉 agent |
|---|---|
| `hard_stop` | 别换写法重试 |
| `use_alternative` | 用更安全的等价写法 |
| `scope_down` | 缩小目标范围 |
| `manual_only` | 让用户自己跑 |
| `stop_and_explain` | 停下来解释 |

这直击我们 R2 的老问题：拦了之后模型换个写法再试（`rm -rf` → `find -delete` → `powershell Remove-Item`）。我们现在卡片文案是陈述式的。加一层 intent 只需在规则表里多一个字段和 i18n 多五条文案。

### 6.3 坏配置要可观测（`degraded` / `configFallback`）

它的做法：非法字段回落到保护性默认、保留合法字段、运行时标 `degraded`、审计里写 `configFallback`；[recovery 页](https://ccsafetynet.com/docs/configuration/recovery.md)专门解释 `degraded` 与 "Runtime is enforcing a fallback configuration" 这两种状态，以及"哪些保护仍然生效"。它自己的文档也警告"拼错的 deny path 会静默失去保护，改完请跑 `status`"——这正是我们 `index.js:163-182` 的毛病（静默吞解析失败，且从不读 `policy.version`）。

P3 `§6` 的校验器解决"写错时拒载"，但**没解决"运行中降级了却看不出来"**。补两样：策略对象带 `degraded` 标志；审计事件加 `configFallback` 字段。

### 6.4 项目策略放宽要逐行上报

它允许项目级 `policy.json` 放宽用户策略，但每一条放宽都打成日志行（`project policy lowers level: x -> y`），`status`/`doctor`/状态行 🔻 全部显示；`CC_SAFETY_NET_PROJECT_TIGHTEN_ONLY=1` 一键拒绝所有放宽。

我们暂时用不上（只有用户域一份策略）。但**如果将来做项目级**，这是唯一不会让用户后背发凉的设计：放宽必须留痕、必须能一键关死。

### 6.5 `explain` / trace

`explain --json` 输出可回放的 TraceStep，`status` 告诉你当前**生效**的是哪档、哪些 override 在起作用。我们的 check CLI 草案（P3 `§4`）只有 verdict + 退出码。P3 引擎 v2 的 `reasons[]` 正好是 `--trace` 的天然载体——既然要为 quiet 收集"赢家之外还命中了什么"，顺手把它输出出来，成本几乎为零。

### 6.6 改规则必须先跑 fixture 才落盘

它的 rulebook 带 `tests` fixtures，`rule add/update/verify` 会跑，GitHub 源钉 commit、拒重定向、fixture 过了才写盘；rulebook **只能加规则，不能删内置规则**。

我们的契约表（P3 `§5`）已经是这个思路的一半。差的是"机械约束"：现在靠"记得跑 `npm test`"，它靠命令级拒绝落盘。

### 6.7 逐 host 的 fail-open 表

`known-limitations.md` 有一张表，逐个宿主列"钩子崩了是放行还是拦截"。DSH 有 `web` / `desktop` / `acp` / `headless` / `sdk` 多个 profile，我们只说"加载失败静默裸奔"，没做成"哪个 profile 会怎样"的表。这是**纯文档**，且正好治 §4.2 那个"以为有保护"的问题。

---

## 7. 明确不学

| 不学 | 理由 |
|---|---|
| 写命令解析器 | 它的深度是多年、多语言（POSIX/PowerShell/cmd/解释器）堆出来的；我们在 Windows-only + 零依赖 + 128 条测试的约束下做不出同等覆盖，硬上就是换血 |
| `standard/strict/paranoid` 等级 | 与我们 `mode` 语义会冲突成两套词汇（用户要记"档"和"模式"两种东西） |
| deny-only | ask 是 DSH 原生能力，也是我们相比它唯一的体验优势 |
| 12 个 CLI 子命令 + GUI 看板 | 我们要的是 `check` 一个动词 + 一个报告脚本；再多就是自建平台 |
| `rule.json` 双文件配置 | 两份配置 = 两个"我改的是哪个"的问题；P3 的 `entries[]` 一份就够 |

---

## 8. 现在装不装

**不装。** 四条理由，按硬度排序：

1. **它挂在审批之后**（§4.1）——用户在我们卡片上批准，它还能 deny，体验直接崩；
2. **装进 profile 属于 R1**（改 `~/.dsh`），要备份 + 逐次批准，而收益落在"我们已覆盖的部分"；
3. **静默裸奔叠加**（§4.2）——两个护栏让"到底有没有保护"更难判断，与 P3 想要达成的效果相反；
4. **它盖不到我们真正的洞**（§4.3：`run_code`、`terminal_send`、插件自带 shell 工具、`apply_patch`）。

什么情况下值得重新评估：

- 我们开始支持 POSIX/macOS（那时它的 git/rm 语义知识真有价值）
- DSH 侧它把 `run_code` 与声明式 shell 工具补上
- 我们决定**不做** P3 的 check CLI，而需要一个外部可调用的判定器（它的 `cc-safety-net/api` 的 `checkCommand` 可以直接用）

---

## 9. 怎么复核

它的文档站是 Mintlify，任意页面 URL 加 `.md` 拿原文；`/llms.txt` 是索引。

| 主题 | URL |
|---|---|
| 引擎七阶段 | https://ccsafetynet.com/docs/guides/how-it-works.md |
| 命令规则全表 | https://ccsafetynet.com/docs/reference/blocked-commands.md |
| 审计字段与留存 | https://ccsafetynet.com/docs/reference/audit-log.md |
| 残余风险登记（raw） | https://raw.githubusercontent.com/kenryu42/cc-safety-net/main/docs/residual-risk-registry.json |
| 密钥保护（按文件名/目录拦） | https://ccsafetynet.com/docs/reference/secret-protection.md |
| 配置降级与恢复 | https://ccsafetynet.com/docs/configuration/recovery.md |
| trace 字段 schema | https://ccsafetynet.com/docs/reference/explain-trace.md |
| 已知限制 / fail-open 表 | https://ccsafetynet.com/docs/guides/known-limitations.md |
| 安全模型 | https://ccsafetynet.com/docs/guides/security-model.md |
| 与沙箱的分工 | https://ccsafetynet.com/docs/guides/vs-sandboxing.md |
| DSH 安装与行为 | https://ccsafetynet.com/docs/installation/deepseek-harness.md |

本机复核注意：**pwsh 侧 TLS 不可用**，`Invoke-WebRequest` / `curl.exe` 都拉不到 GitHub；用 DSH 的 `web_fetch`（服务端抓取）或浏览器。

---

## 10. 对 P3 草案的修订建议

如果认下第 6 节，`design/p3-policy-v2.md` 要动五处（都还不影响实现，属文档层）：

| P3 位置 | 改什么 | 为什么 |
|---|---|---|
| `§3.4` + `§9` | 合并成 `docs/residual-risk-registry.json`，`§9` 表格改指向它；每条 RR 带 id、受影响模式、对应 `knownGap` fixture、裁决来源 | 6.1。同一件事不该有两份说法 |
| `§2` 返回值 | `reasons[]` 之外加 `intent`（按规则带给定） | 6.2。决定卡片末行给 agent 什么指令 |
| `§6` 校验器 | 加"运行中降级"语义：`degraded` 标志 + 审计 `configFallback` 字段 | 6.3。治"改坏了静默失效" |
| `§4` check CLI | `--json` 里输出 trace（命中与被跳过的规则），复用 `reasons[]` | 6.5。让"为什么放行"可回答 |
| `§8` 验收 | 加一条：每条 `knownGap` 必须能反查一条 RR；反向也成立 | 6.1。让登记表不是摆设 |

第 6.4（项目策略放宽上报）、6.6（fixture 门槛）、6.7（fail-open 表）不进 P3，记为 P4 候选。

---

## 附：一条没能完成的核查

想读它的 `dist/deepseek-harness/cordis.patch.yml` 确认 DSH 侧到底怎么挂监听器、以及 guard 源码是否真如文档所说的"跑在最后"，**失败了**（TLS 出口问题，见 §9）。因此本文中所有"Dsh 侧行为"均转述自它的文档；如果将来真要装它或抄它的集成方式，这一条必须改成实测。
