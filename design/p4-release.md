# P4 发布工程：从私有仓库到公开仓库

**用途**：记录 P4（开源发布）的边界、拍板、分批落地与验证证据。开工单是 `design/p4-handoff.md`，本文是它的
执行记录。P1–P3 的设计分别见 `design/p1.7-workspace-quiet.md`、`design/p3-policy-v2.md`；路线图原文在仓库外
`D:\work\DSH-guardrails-DOCS\implementation-plan.md` §7。

P4 只做发布工程：**不动引擎语义、不加规则、不引新依赖、只承诺 Windows**。本文的每一节都以"能当场复跑的命令"
或"带时间的输出"结尾，验证不了的单列在 §10。

## 0. 现状核对（2026-11-17 18:00，只读）

- 版本 **1.5.0**；`v1.5.0` 与 `p3` 两个附注 tag 都指向 1.5.0 收口的那个提交（历史重写后为 `0c5afd9`）。
- 测试 **18 个文件 404 条**全绿，由 `dsh-guardrails/package.json` 的 `scripts.test` 逐文件串联（本机没有 `npm`，
  用 bundled node 逐文件跑，见 §3.3）。
- 包 `@vlad/dsh-guardrails`，`"private": true`，MIT，`engines.dsh: ">=0.2.0-0"`；没有发布到 npm，也没有 CI。
- 仓库已有 `LICENSE`、`.gitignore`、`.gitattributes`、双语 `README`/`CHANGELOG`、`docs/` 六份、`examples/policy/` 四份。

### 0.1 开工单与事实的三处偏差（已修）

| 位置 | 原文 | 事实 | 处理 |
|---|---|---|---|
| `README.md:12`、`README.zh-CN.md:11` | "pre-1.0 / 1.0 之前" | 版本已是 1.5.0 | 改为 `1.x` |
| `dsh-guardrails/docs/ARCHITECTURE.md:120` | "16 of them"（测试文件） | 当时 17 个，加 `docs.test.mjs` 后 18 个 | 去掉硬编码数字，改成"跑 `test/` 下每个文件" |
| `README.md:134`、`README.zh-CN.md:124` | `quiet.roots` 示例用本机真实仓库路径 | 应给通用占位 | 改为 `D:\work\guardrails` |

## 1. 目标与非目标

**目标**：外人拿到仓库，一小时内能装进自己的 DSH、看到一次拦截、改一条自己的规则、知道去哪查为什么被拦。

**非目标**：不承诺跨平台（Windows-only，判定依赖 PowerShell 动词、盘符、注册表/服务/计划任务语义）；不做沙箱；
不引入 LLM、不联网判定；**不改引擎语义**——本轮的证据是引擎文件零 diff：

```
git diff --stat 2251613..HEAD -- dsh-guardrails/lib dsh-guardrails/rules.js dsh-guardrails/index.js   # 空
```

## 2. 四个拍板问题与结论（2026-11-17，用户确认）

| # | 问题 | 决定 | 理由 | 后果 |
|---|---|---|---|---|
| 1 | 版权署名 | 保持 `Copyright (c) 2026 Vlad` | 维持现状 | `LICENSE` 不动 |
| 2 | 包名与 scope | 保留 `@vlad/dsh-guardrails` | 无 scope 的 `dsh-guardrails` 已被 npm 占用 | 不改 `name`；npm 发布不在 P4 范围 |
| 3 | 仓库可见性 | **先私有**，P4 过程中逐项验证后再转公开 | "现在还不能完全验证的状态"；私有→公开的过渡本身就是 P4 的设计内容 | `"private": true` 暂留；公开切换是 P4 的最后一个动作 |
| 4 | `design/` 是否公开 | 公开，本机路径改成通用占位 | 决策与踩坑记录是项目最有价值的部分之一 | 需要历史重写（§4） |
| 5 | `scripts/` 是否公开 | 不公开 | 个人运维脚本，依赖本机布局 | 继续留在 `.gitignore`，`files` 白名单不含它 |

第 2 与第 3 条合起来有一个直接后果：**P4 不做 `npm publish`**。`private: true` 会让 `npm publish` 直接失败，
这是有意的——包名先留着，等公开切换时再一并决定是否发布。

## 3. 阶段 A：不依赖拍板的工作（已完成）

### 3.1 `SECURITY.md`

只支持 `1.x`；`<1.0` 不支持；Windows-only，其他平台不在范围。报告走 GitHub **Security → Report a vulnerability**，
仓库私有期走同一入口或仓库持有者账户；明确要求隐去路径、密钥与审计行。范围内：R1/R2/R3/`entries` 任一档被绕过、
未写进文档的 fail-open、审计链断开、策略校验把削弱当合法。范围外：工具边界以外、`knownGap: true` 的已知缺口、
其他系统、超大命令 DoS、社会工程。响应：尽力 7 天确认、无赏金、默认 90 天协同披露。

### 3.2 `CONTRIBUTING.md`

写清三件事：加一条规则要碰哪些文件（`lib/rules/kit.js` 的模式表 → `rules.js` 的档位接线 →
`test/fixtures/contract-cases.json` 的用例 → `i18n/{en,zh}.json` + `lib/describe.js` 的卡片文案 →
`docs/DETAIL*.md` 与 `CHANGELOG`）；协议规则（`1.x` 内只加不改，改名/删除升 2.0 并写迁移说明）；
测试怎么跑（逐文件、不用 `node --test`、不许子进程）。

### 3.3 新测试 `dsh-guardrails/test/docs.test.mjs`

四条断言，把"文档能不能照做"变成红灯而不是靠人眼：

1. `i18n/en.json` 与 `i18n/zh.json` 的 key 集合相等；
2. 每个 key 的 `{placeholder}` 集合相等（此前只靠人守，两份今天恰好一致）；
3. 所有文案是非空字符串；
4. 所有被跟踪 `.md` 里的相对链接都能解析（剥掉 `#锚点`，跳过 `http(s)`/`mailto`，剥围栏代码块，
   并断言"找到的链接数 ≥ 25"，防止遍历器失效后静默通过）。

它是第 18 个测试文件，`scripts.test` 现在以 `... && node test/plugin.smoke.mjs && node test/docs.test.mjs` 结尾。

### 3.4 事实修正与去个人化（清单）

| 文件 | 改动 |
|---|---|
| `README.md`、`README.zh-CN.md` | `pre-1.0`→`1.x`；`seventeen/十七个`→`eighteen/十八个`；文档地图与仓库结构表加 `SECURITY`/`CONTRIBUTING` 两行；`quiet.roots` 示例换占位 |
| `dsh-guardrails/docs/ARCHITECTURE.md` | 去掉"16 of them"硬编码计数 |
| `design/p4-handoff.md` | 计数 17/400→18/404；§2 记录四个拍板；§3 勾选并附证据；路线图路径换占位 |
| `design/p1.7-workspace-quiet.md:20`、`design/p3-policy-v2.md:6,327,461,555,643,646,659`、`design/p3-handoff.md:6,56,65` | 本机仓库路径、bundled node 路径、宿主安装路径换成 `D:\work\...` / `%USERPROFILE%\...` / `%LOCALAPPDATA%\...` |
| `test/policy-schema.test.mjs:24,113`、`test/replay.test.mjs:37` | 真实仓库路径 → `D:\work\guardrails` |
| `test/self-protect.test.mjs:182` | `CWD` 原本写死真实仓库路径，只因检出位置恰好相同而通过；改为 `dirname(pluginRoot())`，与机器无关 |
| `CHANGELOG.md`、`CHANGELOG.zh-CN.md` | 新增双语 `[Unreleased]`，四条：文书补齐、文档测试、占位替换、过时事实修正 |

### 3.5 证据（2026-11-17 17:4x）

- 全套 **18 文件 404 条 / 0 失败**：audit 11、cli 78、contract 73、critical 15、describe 17、docs 4、dry-run 10、
  engine-v2 19、examples 4、facts 29、finalize 9、plugin.smoke 38、policy-schema 10、quiet 19、redact 9、replay 3、
  rules 34、self-protect 22。
- 负对照：把 `i18n/en.json` 的 `action.delete` 改名 → `docs.test.mjs` 报 `pass 3 / fail 1` 并列出缺失 key；改回来恢复 `pass 4`。
  链接检查器的负对照：在临时树里放一个断链 → 被点名报出。
- `git ls-files --eol`：新增/修改文件均为 `i/lf w/lf attr/text eol=lf`；文件头无 BOM。
- **未验证**：`npm test` 本身没跑过（本机没有 `npm`），404 是逐文件跑出来的和。

## 4. 历史重写（2026-11-17 17:49–18:02，用户执行）

### 4.1 为什么必须重写

只改工作树不够：`git grep` 显示 **8 条提交**碰过 `My Documents`、**2 条**碰过 `Administrator`。当时共 54 条提交，
凡是读过旧历史的克隆都能拿到原路径。所以要么重写，要么接受"公开即泄露目录结构"。

### 4.2 替换表

`git filter-repo --replace-text` 的 `literal:` 规则，按顺序取第一个匹配，所以"先具体、后通用"：

```
literal:D:\work\guardrails==>D:\work\guardrails
literal:D:\\work\\guardrails==>D:\\work\\guardrails
literal:D:\work\DSH-guardrails-DOCS==>D:\work\DSH-guardrails-DOCS
literal:D:\work\==>D:\work\
literal:D:\\work\\==>D:\\work\\
literal:C:\Users\<you>==>C:\Users\<you>
literal:C:\\Users\\\<you>==>C:\\Users\\<you>
```

第 2、5、7 行是同一路径在 JS/JSON/PowerShell 字符串里被转义成双反斜杠的形态。提交消息不用改：
`git log --all --format=%B` 对两条关键词 0 命中，唯一作者身份是 GitHub noreply 地址。

### 4.3 执行顺序

1. 先把阶段 A 的四条提交推到远端；
2. `git clone --mirror <repo> %TEMP%\guardrails-rewrite-<ts>`，在镜像里跑 `git filter-repo --force --replace-text <表>`；
3. `filter-repo` 会删掉 `origin`（防止误推），必须重新 `git remote add origin <repo>`；
4. 在镜像里验证：`git log --all --oneline -S 'My Documents'`、`-S 'Users\Administrator'` 均为空；
5. `git push --force --mirror origin`（连 tag 一起）；
6. 本地 `git fetch --force --tags && git reset --hard origin/main`（tag 也被重写，必须带 `--force --tags`）。

### 4.4 验证证据（2026-11-17 18:02，本地仓库）

| 检查 | 结果 |
|---|---|
| `git status -sb` | `## main...origin/main`，无 ahead/behind |
| `git rev-list --count HEAD` | `59`（重写前的 54 条 + P4 的 5 条；之后随新提交增长） |
| `git log --all -S 'My Documents'` | 空 |
| `git log --all -S 'Users\Administrator'` | 空 |
| `git grep -c 'My Documents'` | 无命中（exit 1） |
| `git rev-parse "v1.5.0^{commit}" "p3^{commit}"` | 两者都是 `0c5afd9`，tag 关系未拆散 |

阶段 A 四条提交在重写后的哈希：`d2d53b8`（文书）→ `84452fd`（文档测试）→ `d28bfc1`（占位替换）→ `919420d`（CHANGELOG）。
重写前的哈希全部作废，引用改动请用消息或文件内容。

### 4.5 副作用

- 所有提交哈希改变；本地 `reflog` 与 `.git` 里仍有旧对象（在你自己机器上，无泄露问题，但不能把 `.git` 打包分发）。
- 附注 tag 的对象哈希也变了（`v1.5.0` 的 tag 对象与 `p3` 的不同，但解引用到同一提交）。
- GitHub 可能仍按旧 SHA 提供缓存对象。私有期无影响；**转公开前**若要彻底清掉，需要 GitHub 支持做一次 purge，
  或干脆删库重建（P4 收尾时二选一，见 §9）。

### 4.6 远端删除重建（2026-11-17 22:45，用户执行）

force-push 只保证"新历史里没有路径"，不保证旧对象不可达；GitHub 的 purge 是人工工单，且官方只协助"无法靠轮换凭据缓解
的敏感数据"，目录名很可能被判为非敏感数据而拒绝。因此改走确定性更高的一条路：

1. 本地先确认无未推提交，并 `git bundle create <备份>.bundle --all` 留一份离线副本；
2. GitHub 仓库 Settings → Danger Zone 删除 `VladimirKuzen/DSH-guardrails`（不可逆，需手输仓库名）；
3. 立刻重建同名仓库：同 owner、same name、**Private**、不初始化 README/.gitignore/LICENSE；
4. 从本地灌入：`git push -u origin main` + `git push origin --tags`（**不用** `git push --mirror`，它会把
   `refs/remotes/origin/*` 也推成远端分支），期望远端共 11 个 ref：1 个 `refs/heads/main` + 10 个 tag；
5. 验证：`git ls-remote origin` 11 行、`main` 指向 `48c818f`；浏览器打开旧提交页 `.../commit/82cdcd7` 应为 **404**
   （新仓库没有旧对象，不需要工单）。

本地侧已核对（2026-11-17 22:48）：`main` = `origin/main` = `48c818f`、提交 59 条、tag 10 个，且 tag 对象哈希与
重写后一致（`v1.5.0` = `7ca2ff0`、`p3` = `9748b32`，解引用后同为 `0c5afd9`）。**远端侧未由本机核对**：沙箱里的
`git fetch`/`git ls-remote` 报 `schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS`，凭证只在用户的
交互会话里可用；远端 refs 数量以用户执行的 `git ls-remote origin` 为准（§10-8）。

## 5. 阶段 B：包元数据（已完成，2026-11-17 22:5x）

- [x] `package.json` 补 `repository` / `homepage` / `bugs`，指向 `https://github.com/VladimirKuzen/DSH-guardrails`；
      `repository.directory` 写 `dsh-guardrails`，因为包在仓库子目录里，不写会让 npm 页面的"代码"链接指到根。
- [x] `"private": true` 保持原样：可见性切换与摘 `private` 是两件事，留到最后一步单独做。
- [x] `engines.dsh` 的核对：宿主 desktop 版本是 **`0.2.2-rc.1`**（`~/.dsh/dsh-runtimes/dsh-primary-runtime/runtime.json`
      的 `desktopVersion` 字段），插件在其上加载为 `version 1.5.0 / surface ok`（`~/.dsh/guardrails/loaded.json`，
      2026-11-17T14:36:47Z）。**没有观察到宿主校验 `engines.dsh`**，所以 README 按"仅在 0.2.2-rc.1 上测过、
      其他版本未测"写明，不声称已验证范围语义。
- [x] 双语 README 的安装一节写明测试过的宿主版本；`CHANGELOG` 的 `[Unreleased]` 补一条。
- [x] 打包自检（本机没有 `npm`，用 bundled pnpm）：首轮 `pnpm pack` 为 38 条、白名单文件齐全，但 tarball 里
      **没有 `README`/`LICENSE`**——两者都在仓库根，而 npm 只收包目录里的文件。已在 `dsh-guardrails/`
      内补一份包级 `README.md` 与 `LICENSE` 副本，重新打包后多出 `package/README.md` 与 `package/LICENSE`
      （共 40 条），`test/`、`design/` 仍为 0 条。

证据（2026-11-17 22:53）：`node -e` 解析 `package.json` 通过；全套 18 文件 404 条仍全绿。

## 6. 阶段 C：CI（已落地，2026-11-17 23:1x；首次远端运行待观察）

- [x] GitHub Actions：`windows-latest` + Node 24（宿主自带 24.21.0），跑 `npm test`（18 个文件串联）。
- [x] `check` CLI 冒烟：`'{"command":"git reset --hard"}' | node tools/check.mjs --policy
      examples/policy/minimal-v1.json --tool pwsh --args -`，期望退出码 2；断言后用 `$global:LASTEXITCODE = 0`
      清掉，否则 pwsh 包装层会把 2 当成本步的退出码。
- [x] 不建 macOS/Linux job（见 §1 非目标）；不装依赖（零依赖、无 lockfile，`npm ci` 会失败）。
- [x] 两个 action 按 commit SHA 钉死：`actions/checkout@3d3c42e5...`（v7.0.1）、
      `actions/setup-node@949feb24...`（v7.1.0）。SHA 取自 GitHub API 的 `git/ref/tags/<tag>`（2026-11-17 23:0x），
      注释里只写主版本号，避免版本号写错。

验证边界：本机没有 YAML 解析器（Python 无 `yaml`，node 运行时不带），所以只做了结构检查
（`_scratch/check-workflow.mjs`：无 tab、无 BOM、两个 `uses:` 都是 40 位 SHA 且与预期一致、冒烟步骤的
命令与断言都在）。**YAML 的合法性以 GitHub 的第一次 run 为准**——这也是本次 CI 的第二重意义。

## 7. 阶段 D：一小时内验收（待办）

按 `design/p4-handoff.md` §7 的七步走一遍。公开前能做的只有"本地等价"版本：安装→`loaded.json`、`check` 模板、
真实弹卡、三档灰度、`--verify` 链校验、文档升级核查、`CONTRIBUTING` 规则三步。真正的"外人视角"要等仓库公开后
用一个干净 profile 再走一次。

## 8. 验收矩阵

| # | 命令 | 期望 | 现状 |
|---|---|---|---|
| 1 | `node test/docs.test.mjs` | `pass 4` | 通过（2026-11-17） |
| 2 | `git grep -n 'My Documents\|Users\\Administrator'` | 无命中 | 通过（18:02） |
| 3 | `git log --all -S 'My Documents'` | 空 | 通过（18:02） |
| 4 | `git rev-parse "v1.5.0^{commit}" "p3^{commit}"` | 同一提交 | 通过（18:02） |
| 5 | `node tools/check.mjs --policy examples/policy/minimal-v1.json --tool pwsh --args '{"command":"git reset --hard"}'` | exit 2 | 阶段 D 复跑 |
| 6 | 公开后：干净 profile 按 README 装一遍 | `loaded.json` 出现 `version` + `surface:"ok"` | 待公开 |

## 9. 风险登记（P4 新增）

- **旧 SHA 残留**：见 §4.5。私有→公开前二选一（GitHub purge / 删库重建）。
- **`private: true` 与公开**：可见性切换与 `private` 摘除是两件事——GitHub 仓库可见性与 npm `private` 字段互不影响，
  不要在一次提交里同时改，否则回滚时说不清是哪一个生效。
- **`npm` 缺失**：本机无法验证 `npm test`、`npm pack`、`npm install`；CI 是第一次真实执行。
- **`engines.dsh` 未验证**：宿主是否校验该字段没有实测过。
- **`design/` 公开后不可撤回**：路径已通用化，但决策与失败记录会永久可见（这正是选择公开的理由）。

## 10. 未验证项（不写"应该没问题"）

1. `npm test` 与 `npm ci`：本机没有 `npm`，从未执行。
2. `npm pack` 的产物内容、`files` 白名单是否漏文件：未执行。
3. `engines.dsh` 的宿主校验行为：在 `0.2.2-rc.1` 上插件正常加载，但没有观察到任何校验动作；宿主是否按
   semver 校验、范围 `>=0.2.0-0` 对预发布版本（`0.2.2-rc.1`）是否成立，均未验证。
4. GitHub Actions 工作流：尚未编写，自然也未跑过。
5. 仓库可见性切换：未执行（P4 的最后一个动作）。
6. GitHub Release 页面与 tag 归档：未创建。
7. "外人一小时装好"：需要一条干净 profile，公开后补做。
8. 重建后的远端内容：本机沙箱拿不到 GitHub 凭证（`SEC_E_NO_CREDENTIALS`），只能由用户跑 `git ls-remote origin`
   （期望 11 个 ref）与打开旧提交 URL（期望 404）来确认。

## 11. 与既有文档的同步点

- `design/p4-handoff.md` §0 的提交哈希改成"见 `git log`"（重写后旧哈希不存在），§2 记拍板结果，§3 勾选；
- `README.md` / `README.zh-CN.md` 的文档地图与结构表指向 `SECURITY.md`、`CONTRIBUTING.md`；
- `CHANGELOG.md` / `CHANGELOG.zh-CN.md` 的 `[Unreleased]` 随每条实质改动追加；
- `design/p3-handoff.md` 是 P3 收口快照：只把路径换成占位，**不改**它的测试数（历史记录，不是现状）。
