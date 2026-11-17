# 横向对照：cc-safety-net 与本项目

- 状态：**参考材料 v2（2026-11-17）**，只读调研；v1 写于 2026-11-16
- 用途：给"要不要装别人的护栏 / 要不要学它的做法"提供一份外部参照——不是要抄谁，是先把"同一块地别人怎么盖"看清楚
- 对象：https://github.com/kenryu42/cc-safety-net，npm `cc-safety-net` **v2.7.15**（2026-11-17 取自 `registry.npmjs.org`；它的文档站首页还缓存着 v2.7.4），MIT，Node ≥22；与之相对的本方版本是 **1.5.0**（宿主 desktop 0.2.2-rc.1）
- 来源：**只有官方文档与 npm 元数据**。本机 pwsh 的 TLS 出口不可用（`curl.exe` 报 `schannel: ... SEC_E_NO_CREDENTIALS`），拉不到它的 `dist/`，所以**没有读过一行实现源码**；DSH 一侧的页面通过本会话的 `web_fetch` 抓取（服务端出口）。下文中凡是描述"它怎么实现"的地方，依据都是它自己写的文档，可能比代码乐观
- 日期：外部信息截至 2026-11-17；该包迭代快（`v2.7.x`），引用具体行为时标明出处页面

## 0. v1 → v2 变了什么

| 项 | v1（2026-11-16） | v2（2026-11-17） |
|---|---|---|
| 对方版本 | 2.7.13 | 2.7.15；七阶段顺序、`intent` 五值、安装方式都没变 |
| 我方版本 | 1.4.0 | 1.5.0：引擎 v2、`entries[]`、`observe`、两阶段预演、工作区静默、`check`、审计 v2（哈希链 + `--verify`）、自保护 |
| 规则计数 | "30 条正则" | **23 条**（v1 把注释行与紧缩写法的行也算进去了），见 §3 表 |
| 第 6 节七条建议 | 全部"待做" | 逐条标注落地情况：P3 收口时**五条没进 1.5.0**，两条半落地 |
| 新发现 | — | 我们自己的 `apply_patch` 缺口收窄了但没消失：R1 自保护读补丁文本，R1（`~/.dsh`）不读（§4.3 有 2026-11-17 23:41 的实测） |

---

## 1. 它是什么

一句话：**一个只做 deny 的 `tools/pre-execute` 护栏，核心是一个本地命令行解析器。**

- 覆盖 16 个 agent、四种集成模型（stdin hook / agent 自带插件 / 进程内扩展 / 事件插件）；DSH 走"agent 自带插件"这一路：`"dsh": { "bundle": { "patch": "./dist/deepseek-harness/cordis.patch.yml" } }`
- DSH 安装：`npx -y cc-safety-net@latest install --deepseek-harness`，**只覆盖 `web` 与 `desktop` 两个 profile**；`acp` / `headless` / `sdk` / `sdk-minimal` 以及之后新建的 profile 都不覆盖，要手动 `dsh plugin --profile <name> add cc-safety-net`。安装需要 PATH 上有 `pnpm`
- DSH 侧读法：`bash` 走 POSIX 分析器、`pwsh` 走 PowerShell 分析器、文件/搜索工具走路径与密钥检查
- 它自己的定位是"命令层"，且**只拦不批**："deny-only tool guard，能拦但永远不批准"。文档明确说不是沙箱，无网络层，symlink 的 TOCTOU 关不掉
- 它在 DSH 里的失败语义有两条，值得分别记：hook 出错时 **DSH 拦截该调用**（fail closed）；而 bundle 加载失败时只告警，那个 profile 等于没装

对我们最重要的一条实现事实，出自它的 DSH 页面：

> runs the guard after every other `tools/pre-execute` listener, including approvals and Auto review

也就是说，**它把自己排在我们后面**。第 4.1 节展开。

另一条只写在它安装页、不写在概览里的：**Windows Desktop 的路径它没有测**（`dsh.cmd` 与 `%APPDATA%\@deepseek-ai\dsh-desktop\lockfile`），web profile 不受影响。我们是 Windows-only 的插件，这条比任何规则表都更影响"能不能装"。

---

## 2. 它的引擎：七个阶段，顺序即承诺

`docs/guides/how-it-works.md` 给的是固定顺序，不是"大概先做这个"（2026-11-17 复核，与 v1 记录一致）：

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

1. **③④ 跑在配置加载之前**，因此没有任何一份 `policy.json` 能削弱它们。我们的对应物是 R1 自保护（`lib/rules/r1-self.js:83-87` 直接把 `off`/`allow` 当成不放行），结论相同，但没有把"阶段编号"写成结构性约束。
2. **分析失败一律拒**（fail closed），且失败本身有 id。我们的对应物是 `rules.js:62-77` 的 `criticalFallback`：只在"求值抛错、且这条命令仍命中 critical 匹配器"时拒绝，其余情况按 fail-open 放行，`docs/DSH-API.md:22` 明说了这一点。

它能解析的深度（同页面）：`sh -c`/`bash -c`/`sudo`/`env`/`python -c`/`node -e` 解包最深 10 层，更深直接拒；同命令内跟 `cd`；shell 函数按调用点分析；heredoc 区分"数据"与"程序"；磁盘上被调用的 shell 脚本会读，报错定位到 `deploy.sh:3: `；`python3 tool.py` 这种解释器文件不读；`if`/`while`/`{ …; }` 体内照查；动态目标（`rm -rf "$target"`）在 Standard 档放行、strict/paranoid 拦。

---

## 3. 重合在哪

| 维度 | cc-safety-net 2.7.15 | 我们（dsh-guardrails 1.5.0） |
|---|---|---|
| 挂载 | `tools/pre-execute`，排最后 | `dsh-guardrails/index.js:394`，同一个钩子 |
| 决策集 | 只有 deny / allow | deny / ask / observe |
| 规则形态 | 语法解析 + 规则库 | 正则表 + 少量结构匹配（写路径的操作数解析、补丁目标扫描） |
| 规则 id | `git.reset-hard`、`rm.recursive-force-root-or-home`、`guard.policy-config` | `R1` / `R2` / `R3`（加 `category`/`label`），v2 加 `E`（用户 `entries`） |
| 不可关层 | 10 条 catastrophic + `guard.*` | critical 层（`lib/critical.js`）+ R1 与 R1 自保护（校验器拒绝 `off`/`allow`） |
| 策略文件 | `policy.json` + `rule.json` 两份，另可项目级 | 单份 `policy.json`，schema v2（含 `entries[]`、`observe`） |
| 审计 | JSONL 按项目/月分文件 | JSONL v2，带哈希链，`tools/audit-report.mjs --verify` |
| 自保护 | 有：`policy.json` 不可写、`policy apply` 不可跑 | 有：R1 自保护，`apply_patch` 的补丁文本也读 |
| 可解释性 | `explain --json`，可回放 trace | `check --json`：`winner` / `reasons` / `facts`，没有"被跳过的规则" |
| 交付面 | 12 个 CLI 子命令 + GUI 看板 + 库 API | `check` 与 `audit-report` 两个脚本 |
| 覆盖宿主 | 16 个 agent | 1 个（DSH） |

**重合的实质**：都承认同一批残余风险（动态拼接、解释器、脚本文件体），都选择"失败就往严了走"，都拒绝用 LLM 判定。差别不在态度，在**工程量**：它的规则是解析出来的，我们的规则是匹配出来的。

我们的规则表在 `dsh-guardrails/lib/rules/kit.js`（2026-11-17 实测长度）：

| 常量 | 行 | 内容 |
|---|---|---|
| `DEFAULT_DESTRUCTIVE` | `:17-47` | **23** 条正则，Windows 系统管理动词为主 |
| `DEFAULT_SECRETS` | `:50-69` | 9 条密钥形状 |
| `PATH_TOOLS` | `:85` | `write` / `edit` / `create_file` / `apply_patch`（4 个） |
| `SHELL_TOOLS` | `:88` | `pwsh` / `bash`（2 个） |

---

## 4. 三处会打架的地方（不是重合，是冲突）

### 4.1 它排在审批之后

用户在我们的卡片上点了"批准"，它仍可能再 deny 一次。这不是双保险：DSH 的 ask 是原生能力，它的设计前提是宿主**没有**审批（Claude Code 那条路径：标准档下两个 denial 会变成 permission prompt）。两个装一起，用户会看到"批准了又被拦"，且被拦的理由来自另一套词汇（level / rule id），没法对照我们的审计。

### 4.2 两层失败语义叠在一起，"有没有保护"更难判断

它那边：hook 出错 → DSH 拦调用（fail closed）；bundle 加载失败 → 只告警，profile 裸奔；`doctor` 读磁盘 manifest 不读运行时；Desktop 崩溃恢复会禁用第三方 bundle。

我们这边（1.5.0 已比 v1 好一档，但仍有盲区）：策略文件读不出或校验不过时，`loadPolicy`（`index.js:232-271`）保留上一份好策略、记一条 `config-invalid` / `unreadable` 审计事件，并停止重读到文件再变；`surface: 'degraded'`（`index.js:189`）只表示"宿主接口不全、护栏挂不上"，不表示"策略变弱了"。

结果是：两套装在一起时，"现在到底谁在生效、哪一层在放行"要靠读两份文档加一份审计才能回答。这正是 §6.7 想补的表。

### 4.3 它盖不到我们真正的洞，我们自己也有一个

它的盲区（DSH 页面原文）：PTC 的 `run_code`（模型写的 TS 直接调 Node API，只有它发出的工具调用才进闸）；`terminal_send` 写进常驻 shell 不分析；插件自带的 shell 工具（如 `dsh-ops` 的 `ops_bash`）未在 `rule.json` 里声明前完全不看，只给 agent 提示一次让它自己去声明。

我们这边的 `apply_patch`：P3 记过的缺口是"`pathOf` 拿不到补丁文本里的路径"，现在**只补了一半**——R1 自保护会把 `*** Add/Update/Delete File:` 扫出来（`lib/rules/r1-self.js:64-73`），R1 本体（`lib/rules/r1-home.js:43-52`）仍只读 `pathOf`。实测（2026-11-17 23:41，`tools/check.mjs --args -`）：

- 补丁目标是 `D:\work\guardrails\dsh-guardrails\rules.js` → `review  R1 ask self`，exit 2
- 补丁目标是 `C:\Users\<you>\.dsh\guardrails\policy.json` → `allow  no rule matched`，exit 0

这不是 P4 该修的（P4 冻结引擎），但它是"我们和它比，谁的补丁路径看得住"这一问的准确答案：**自保护看住了，DSH 家目录没看住。**

---

## 5. 双向缺口：两边的知识几乎不重叠

拿它的 [blocked-commands 表](https://ccsafetynet.com/docs/reference/blocked-commands.md) 逐行对我们的 `kit.js:17-47`：

### 5.1 它拦、我们不拦（按对我们的威胁排序）

| 类 | 例 | 我们的现状（1.5.0） |
|---|---|---|
| 目标位置语义 | `rm -rf .` vs `rm -rf ~` vs `rm -rf /` 分档 | 动词命中即 ask，不区分目标（位置语义只在 critical 层与 R1 里出现） |
| git 破坏性 | `git restore`、`git checkout -- <path>`、`git switch --discard-changes`、`git reset --merge`、`git branch -D`、`git stash drop/clear`、`git tag -d`、`git reflog delete`、`git push --delete/--mirror`、`git rm -f` | 只有 `reset --hard` / `clean -f` / `push --force` 三条 |
| 磁盘 | `dd of=/dev/...`、`mkfs.*`、`shred -u`、`wipefs`、`sgdisk`、`parted mklabel` | 只有 `diskpart` / `format` / `format-volume` / `chkdsk /f|/r` / `dism` / `sfc` |
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

这也解释了为什么"抄它的表"不划算：那张表一半的命令在 Windows 上根本跑不起来，另一半（git/rm 变体）要补，得先有**目标位置语义**，而那等于把 R2 从"模式匹配"改成"命令分析"——P4 已明确冻结引擎，这类改动只能排到 2.0。

---

## 6. 值得学的七条（附 1.5.0 的落地情况）

按"本金 / 收益"排。第 1 条仍是唯一可以**不碰引擎**就落地的。

| # | 做法 | 1.5.0 现状（2026-11-17 核对） |
|---|---|---|
| 6.1 | 残余风险登记表 | **未落地**。`grep -r 'residual-risk' lib rules.js index.js` 无命中；P3 `§9` 的 17 条风险表仍是散文表格 |
| 6.2 | 每条规则带 `intent` | **未落地**。`grep intent` 在 `lib`/`rules.js`/`index.js` 无命中，卡片文案仍是陈述式 |
| 6.3 | 坏配置可观测 | **半落地**：校验器拒载 + 审计 `config-invalid`（`index.js:258-268`）；没有运行时的 `degraded` 策略标志，也没有 `configFallback` 审计字段 |
| 6.4 | 项目策略放宽逐行上报 | 不适用（只有用户域一份策略） |
| 6.5 | `explain` / trace | **半落地**：`check --json` 有 `winner`/`reasons`/`facts`；没有"命中但被排序压下去"的完整 trace，也没有回放 |
| 6.6 | 改规则必须先过 fixture | **半落地**：契约表在 `test/fixtures/contract-cases.json`，8 个 `knownGap` 用例被断言"当前放行"；落盘仍无机械闸门，靠记得跑 `npm test` |
| 6.7 | 逐 profile 的 fail-open 表 | **未落地**；`docs/DSH-API.md:22` 只有一行 fail-open 注记 |

### 6.1 残余风险登记表（仍然最该抄）

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

### 6.2 `intent`

它的拦截文案末行不是"已拦截"，而是按 intent 给下一步：`hard_stop`（别换写法重试）/ `use_alternative`（用更安全的等价写法）/ `scope_down`（缩小目标）/ `manual_only`（让用户自己跑）/ `stop_and_explain`（停下来解释）。

这直击我们 R2 的老问题：拦了之后模型换个写法再试（`rm -rf` → `find -delete` → `powershell Remove-Item`）。加一层 intent 在引擎 v2 已有 `reasons[]` 的基础上只需多一个字段和 i18n 五条文案。

### 6.3 `degraded` / `configFallback`

它的做法：非法字段回落到保护性默认、保留合法字段、运行时标 `degraded`、审计里写 `configFallback`。我们 1.5.0 已经解决"写错时拒载、且留一条证据"，还没解决"运行中降级了，但卡片和 `loaded.json` 都看不出来"。

### 6.4 项目策略放宽要逐行上报

它允许项目级 `policy.json` 放宽用户策略，但每条放宽都打日志（`project policy lowers level: x -> y`），`status`/`doctor`/状态行 🔻 全部显示，另有 `CC_SAFETY_NET_PROJECT_TIGHTEN_ONLY=1` 一键拒绝。我们暂时用不上；将来若做项目级，这是唯一不让用户后背发凉的设计。

### 6.5 `explain` / trace

`explain --json` 输出可回放的 TraceStep，`status` 告诉你当前**生效**的是哪档、哪些 override 在起作用。我们的 `check --json` 已经能回答"谁赢、为什么、看到了什么事实"，还不能回答"哪些规则看了但没命中"。引擎 v2 的 `reasons[]` 本就是载体，补 trace 的成本主要在文案。

### 6.6 fixture 门槛

它的 rulebook 带 `tests` fixtures，`rule add/update/verify` 会跑，GitHub 源钉 commit、拒重定向、fixture 过了才写盘；rulebook **只能加规则，不能删内置规则**。我们的契约表已经是这个思路的一半，差的是"机械约束"。

### 6.7 逐 host 的 fail-open 表

`known-limitations.md` 有一张表，逐个宿主列"钩子崩了是放行还是拦截"。DSH 有 `web` / `desktop` / `acp` / `headless` / `sdk` 多个 profile，我们只说"加载失败静默裸奔"，没做成"哪个 profile 会怎样"的表。这是**纯文档**，且正好治 §4.2。

---

## 7. 明确不学

| 不学 | 理由 |
|---|---|
| 写命令解析器 | 它的深度是多年、多语言（POSIX/PowerShell/cmd/解释器）堆出来的；我们在 Windows-only + 零依赖 + 404 条断言的约束下做不出同等覆盖，硬上就是换血 |
| `standard/strict/paranoid` 等级 | 与我们 `mode` 语义会冲突成两套词汇（用户要记"档"和"模式"两种东西） |
| deny-only | ask 是 DSH 原生能力，也是我们相比它唯一的体验优势 |
| 12 个 CLI 子命令 + GUI 看板 | 我们要的是 `check` 一个动词 + 一个报告脚本；再多就是自建平台 |
| `rule.json` 双文件配置 | 两份配置 = 两个"我改的是哪个"的问题；我们的 `entries[]` 一份就够（1.5.0 已落地） |

---

## 8. 现在装不装

**不装。** 五条理由，按硬度排序：

1. **它挂在审批之后**（§4.1）——用户在我们卡片上批准，它还能 deny，体验直接崩；
2. **Windows Desktop 的路径它没测**（§1 末）——我们是 Windows-only，这条是硬伤，不是文档瑕疵；
3. **两层失败语义叠加**（§4.2）——它 hook 出错 fail closed、bundle 载入失败裸奔，我们只在 critical 上兜底，装一起后"到底有没有保护"更难判断；
4. **装进 profile 属于 R1**（改 `~/.dsh`），要备份 + 逐次批准，而收益落在"我们已覆盖的部分"；
5. **它盖不到我们真正的洞**（§4.3：`run_code`、`terminal_send`、插件自带 shell 工具），而我们的 `apply_patch` 缺口它也不补（它看的是自己的 `policy.json`，不是我们的）。

什么情况下值得重新评估：

- 它把 Windows Desktop 的路径测了，并且文档写明
- DSH 侧它把 `run_code` 与声明式 shell 工具补上
- 我们开始支持 POSIX/macOS（那时它的 git/rm 语义知识真有价值）
- 我们决定**不做**自己的判定器，而需要一个外部可调用的库（它的 `cc-safety-net/api` 的 `checkCommand` 可以直接用）

---

## 9. 怎么复核

它的文档站是 Mintlify，任意页面 URL 加 `.md` 拿原文；`/llms.txt` 是索引。

| 主题 | URL |
|---|---|
| npm 元数据（版本、`engines`、`dsh.bundle`） | https://registry.npmjs.org/cc-safety-net/latest |
| 文档索引 | https://ccsafetynet.com/docs/llms.txt |
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

本机复核注意：**pwsh 侧 TLS 不可用**，`Invoke-WebRequest` / `curl.exe` 都拉不到 GitHub 与它的站点；用 DSH 的 `web_fetch`（服务端抓取）或浏览器。本文 2026-11-17 的外部事实即由 `web_fetch` 取得。

---

## 10. 对 P3 草案的五条修订建议：最后没进 1.5.0

v1 给 P3 提了五条文档层修订（合并 RR 登记表、加 `intent`、加降级语义、`--json` 输出 trace、验收加 RR 反查）。P3 收口时这五条**都没有进入 1.5.0**，也没写进 1.5.0 的 CHANGELOG：

| v1 建议 | 1.5.0 实际 | 留在哪 |
|---|---|---|
| RR 登记表 | 没做，`§9` 仍是散文风险表 | 2.0 候选 |
| 规则带 `intent` | 没做 | 2.0 候选（引擎 v2 的 `reasons[]` 是现成载体） |
| 运行时 `degraded` + `configFallback` | 只做了"拒载 + `config-invalid` 审计" | 2.0 候选 |
| `check --json` 带 trace | 做了 `winner`/`reasons`/`facts`，没有跳过项 | 增量可做 |
| 验收里 RR 反查 `knownGap` | 没做；8 个 `knownGap` 用例只断言"当前放行" | 2.0 候选 |

P4 的约束是"不动引擎语义"，所以这份文档在 P4 里只当**输入**：它回答"要不要装"（不装）和"下一版值得学什么"（第 6 节，按上表排序）。真正落地要等 2.0 的提案。

这些条目已按 `C-1`…`C-9` 编号收进 [design/v2-candidates.md](v2-candidates.md)，连同 `apply_patch` 那条实测缺口（`C-1`）。

---

## 附：一条仍然没做的核查

想读它的 `dist/deepseek-harness/cordis.patch.yml` 确认 DSH 侧到底怎么挂监听器、以及 guard 源码是否真如文档所说的"跑在最后"，**仍然没做**：TLS 出口问题拉不到 tarball，而 tarball 是二进制包、`web_fetch` 只解文本。因此本文中所有"DSH 侧行为"均转述自它的文档；如果将来真要装它或抄它的集成方式，这一条必须改成实测。
