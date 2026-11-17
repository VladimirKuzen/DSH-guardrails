# P3 设计：策略 v2、自保护与契约测试

- 状态：**草案 v0.1（2026-11-16）**，未实现，未拍板
- 目标版本：1.5.0（P3 单版交付，内部五步）
- 读者：维护者本人；新会话接手时先读 `design/p3-handoff.md`，再读本文
- 路线图原文：`D:\work\DSH-guardrails-DOCS\implementation-plan.md` §6（自保护、CLI、契约测试）、§9（风险登记）
- 本文用中文写，便于反复阅读；代码注释、`reason`、文件名仍用英文（`constraint.weak.local`）

> 本文是**草案**，不是决议。第 10 节列了三处需要用户拍板的分叉，未拍板前实现方不得自行选定；
> 文中给出的“建议”是默认方案，不是已定决策。

---

## 0. 现状核对（动笔前只读核对，2026-11-16）

### 0.1 与既有文档的三处偏差

| 项 | 文档说的 | 实际 | 处理 |
|---|---|---|---|
| 基线提交 | `main = c3d17ae`（`design/p3-handoff.md` §0） | HEAD = `fc8028f docs(p3): hand off the current state to a fresh session`，工作树干净；差的是交接文档本身 | P3 验收**不要写死 sha**，每步开跑前重新记录 |
| `policy.json` 的 `version` | 计划把它当策略版本号 | `dsh-guardrails/index.js:161-182` 的 `loadPolicy` 从头到尾没读过 `policy.version`；`~/.dsh/guardrails/policy.json:1` 的 `"version":1` 目前是装饰 | P3 第一步让它真的生效：缺失按 `1` 处理 |
| `apply_patch` 的路径识别 | R1 覆盖“写路径的工具” | `dsh-guardrails/lib/rules/kit.js:109-115` 的 `pathOf` 只认 `file_path/filePath/path/target/destination`；`apply_patch` 若只带整段 patch 文本，`pathOf` 返回空，`dsh-guardrails/lib/rules/r1-home.js:42-51` 直接漏 | 现有 R1 的洞，自保护会继承；实现前必须确认宿主参数形状（**未验证**，见 §11） |

### 0.2 已核对的实现事实（本文设计的地基）

| 事实 | 位置 |
|---|---|
| 判定入口唯一，顺序 R3 → R1 → R2c → R2 | `dsh-guardrails/rules.js:65-79` |
| R2 内部顺序：critical → `readOnlyDiagnostic` → 破坏性模式 | `dsh-guardrails/lib/rules/r2-destructive.js:26-44` |
| R2 的 `mode` 只区分 deny/ask，`allow` 会被夹成 ask | `dsh-guardrails/lib/rules/r2-destructive.js:63` |
| R3 命中 shell 一律 deny（不看配置 mode，除 `off`） | `dsh-guardrails/lib/rules/r3-secrets.js:35` |
| payload 不落原文靠 `verdict.rule === 'R3'` 判断 | `dsh-guardrails/index.js:135-138` |
| 审计 target 对 R3 只写路径 | `dsh-guardrails/index.js:124-131` |
| quiet 只在“赢家是 R2 且无 severity”时介入 | `dsh-guardrails/index.js:343-371` |
| 策略文件解析失败是**静默**保留上一份 | `dsh-guardrails/index.js:163-182` |
| 深合并会把未知键原样带过（拼写错误静默失效） | `dsh-guardrails/index.js:80-91` |
| 心跳版本已单一来源（读 package.json） | `dsh-guardrails/index.js:47` |
| 审计事件流五类，报告脚本按字段通用遍历 | `design/p2-audit-v2.md` §4.1；`dsh-guardrails/tools/audit-report.mjs:116` |
| 顺序优先级有三条可断言测试 | `dsh-guardrails/test/rules.test.mjs:259-280` |
| 当前 8 个测试文件 128 条全绿 | `design/p3-handoff.md` §0 |

### 0.3 现有 policy.json 的真实形状

`~/.dsh/guardrails/policy.json` 有 `version:1`、`enabled`、`auditDir`、四个规则块（`protectDshHome` / `destructive`（内含已开启的 `workspaceQuiet`）/ `secrets`），**没有 `critical` 块**——该块由 `dsh-guardrails/index.js:49-58` 的 `DEFAULTS` 提供。这证明“文件只写差异、缺省由代码兜底”是既有约定，v2 必须保持。

---

## 1. 目标与非目标

### 1.1 目标（来自计划 §6）

1. 别人能安全地改：策略表达力够用、坏配置要响、改了能被测。
2. 绕过成本变高：护栏自身源码纳入受保护根；已知绕过登记成回归样例。
3. 判定可复现：同一份策略、同一条命令，CLI 与运行时结论必须一致。

### 1.2 非目标

- 不做沙箱、不做签名（签名留给更后；计划 §10 已明确）。
- 不做跨平台（决策 D2）。
- 不引入任何新依赖；不引入构建链（决策 D5）。
- 不改宿主的卡片结构，卡片仍然**一行**（决策 D6 + 计划 §1 事实表）。

---

## 2. 判定引擎 v2

### 2.1 关键区分：判定顺序 ≠ 结果优先级

现在的顺序（`dsh-guardrails/rules.js:65-79`）同时承载两件事，P3 只能动第二件：

- **匹配器执行顺序**（必须保留）：`dsh-guardrails/lib/rules/r2-destructive.js:26-44` 里 critical 先跑、只读排障再放行、最后才跑破坏性模式。这个顺序本身是逻辑，不是风格（`design/p3-handoff.md` 不变量 1、2）。
- **结果选择**（P3 改为显式优先级）：多命中时谁说话算数。

结论：v2 不是“重排规则”，而是把 `evaluate()` 从「短路返回第一条」改成「收集 → 排序 → 取赢家」。匹配器本身一行不改。

### 2.2 策略文件形状（仅 `version: 2` 启用）

```jsonc
{
  "version": 2,
  "enabled": true,
  "auditDir": "~/.dsh/guardrails/audit",
  "rules": {
    "protectDshHome": {
      "mode": "ask",
      "roots": ["~/.dsh", "~/.agents"],
      "alwaysAskTools": ["plugin_manager"]
    },
    "selfProtect": { "mode": "ask", "paths": [] },
    "critical": { "mode": "deny", "patterns": [], "failClosed": true },
    "destructive": {
      "mode": "ask",
      "patterns": []
    },
    "quiet": { "enabled": false },
    "secrets": { "mode": "ask", "patterns": [] }
  },
  "entries": [
    { "id": "ask-all-shell", "tool": ["pwsh", "bash"], "mode": "ask" },
    {
      "id": "allow-build",
      "tool": ["pwsh"],
      "mode": "allow",
      "when": {
        "cwdUnder": ["D:\\work\\proj"],
        "commandMatches": "^\\s*npm run build\\b"
      }
    }
  ]
}
```

设计约束：

1. **配置词表继续用 `mode`**（`ask | deny | observe | allow | off`），不引入第二套配置写法。计划 §6.1 的 `block > review > allow` 是**内部决策词**（用于排序与文档），不进 JSON 键名，避免“同一个概念两个词”。
2. `entries` 是“按工具 + `when`”的落点，与内置规则共存；每条**必须有 `id`**，命中写进审计，可统计“被哪条放行”。
3. **`entries[].mode: "allow"` 必须带非空 `when`，且至少一个收窄条件**（`cwdUnder` / `targetUnder` / `commandMatches` 之一）。裸 allow 由 schema 拒绝。这是硬规则，不是注释。
4. `when` 只收三种“可证明、便宜”的条件：`cwdUnder[]`（会话 cwd 前缀）、`targetUnder[]`（规范化目标路径前缀）、`commandMatches`（正则）。不引入 glob 展开、存在性探测、LLM 语义判定。
5. `selfProtect.paths` 为空表示“自动取插件目录”（§3.2）。
6. 可选键 `priority` **不接受配置**：优先级是代码常量。允许用户把 allow 排到 block 之上等于送一个后门，schema 直接拒绝该键。
7. **`entries[].mode: "allow"` 不覆盖任何内置命中**（m00429）。rank 0 最低，内置的 `ask`/`deny`/`observe` 只要命中一条，赢家就不是它；所以 allow 条目既不是“豁免”，也不能用来救误拦。它的语义只有三个：审计留痕（`reasons[]` 带 `entryId`，可统计）、声明“这条路径已知安全”（防下一个人当遗漏重查）、灰度期的占位。真正的放宽手段只有**块级** `mode`（§2.3）与 `workspaceQuiet`（§2.2 示例 + `dsh-guardrails/index.js:343-371`）；想让某类命令“别再问”，走的是“降块级 mode + 用 `entries.deny` 把危险子集捞回来”，不是加 allow 条目（风险 14）。注意区分两个 allow：**块级 `allow` 是真放宽**（v2 合法，命中记 allow 后放行），**entries 的 allow 不是**——这条区别本身就要写进手册。

### 2.3 mode → decision 映射

| 配置 `mode` | 内部 decision | rank | 行为 |
|---|---|---|---|
| `deny` | `block` | 3 | 直接拒绝，不弹卡 |
| `ask` | `review` | 2 | 弹卡 |
| `observe` | `observe` | 1 | 记录，放行 |
| `allow` | `allow` | 0 | 记录（仅 entries 有意义），放行 |
| `off` | — | — | 匹配器不运行，**不记录** |

`observe` 排在 `allow` 之上：两者都不拦，但 observe 命中必须留痕，排序靠下会被 allow 条目吃掉记录。
`off` 与 `observe` 的区别要写进文档：`off` = 这段判定不存在；`observe` = 判定存在、结论记录、但不干预。

### 2.4 排序与并列打破

```
rank: block(3) > review(2) > observe(1) > allow(0)

带序（同 rank 时决胜）：R3 → R1home → R1self → R2c → R2d → entries（按声明顺序）
```

带序让 `dsh-guardrails/test/rules.test.mjs:259-280` 的三条 precedence 断言继续成立：R3 先于 R1、R1 先于 critical、critical 先于普通破坏性。

伪代码（`evaluate` 的 v2 分支）：

```
evaluate(policy, call, env):
  if policy 无效 or policy.enabled === false: return null
  version = policy.version ?? 1
  hits = []
  for matcher in [R3, R1home, R1self, R2critical, R2destructive, ...entries]:
      hit = matcher(call, ...)            // 每个匹配器内部顺序不变
      if hit: hits.push(hit)
      if version === 1 and hit: return finalize(hit, [hit])   // 与今天逐字一致
  if hits 为空: return null
  winner = max(hits, by rank then by 带序)
  if R3 命中 且 工具是 shell 且 secrets.mode !== 'off':
      winner = 强制 deny（§2.6-1）
  return finalize(winner, hits)
```

`finalize` 负责：填 `reasons[]`（≤8 条，超出时 `reasonsTruncated: true`）、算 `secretHit`、带 `policyVersion`。

### 2.5 返回值（新字段全部可加可缺）

```js
{
  rule: 'R2', mode: 'ask', reason,            // 兼容旧字段 = 赢家
  severity?, label?, target?,

  reasons: [                                   // 新增：全部命中（最多 8 条）
    { rule, mode, sub?, severity?, entryId? }
  ],
  reasonsTruncated: true,                      // 新增：命中超过 8 条时才有
  secretHit: true,                             // 新增：只要 reasons 里有 R3 就 true
  observed: true,                              // 新增：赢家是 observe 时才有
  policyVersion: 2                             // 新增
}
```

- `reasons[]` 的字段名以实现为准（2026-11-17 核对）：用 `mode` 而不是 `decision`，用 `sub` 区分子带（如 `sub: 'self'`），不带 `reason` 文案。`reasons` / `reasonsTruncated` 在 `fieldsFor()` 与 `lib/audit/v2.js` 的白名单里各写一次——漏一处就会被静默丢弃（`sub` 2026-11-17 就踩过）。
- `reasons[]` **只进审计**，不进卡片。卡片仍是 `describe()` 的一行（`dsh-guardrails/lib/describe.js:64-104` 只吃赢家 + facts）。
- 消费方要改的三处都在 `dsh-guardrails/index.js`：`auditTarget`、`payloadOf`、`fieldsFor`。

### 2.6 四条必须写死的钳制（优先级不得覆盖）

**1. 密钥钳制**

只要任一命中是 R3、工具是 shell、且 `rules.secrets.mode` 不是 `off`，最终一律 `deny`。

**唯一例外：`rules.secrets.mode === 'observe'`。** observe 下 R3 不拦、不弹卡，只写 `observed` 记录，payload 必须先脱敏（第 4 条）。

例外的理由不是“放宽”，而是本钳制的**成因不成立**：卡片会回显 `args.command`，而 observe 根本不产生卡片。反过来，把 observe 也夹成 deny，等于让最需要预演的密钥规则永远预演不了——误报代价最高的一类规则偏偏不能灰度，是设计缺陷。注意例外的对象是**配置为 observe 的 R3 条目**；其他规则命中 R3 时想把结果降级成 `ask`/`allow`，仍然一律 `deny`（风险 2）。

**卡片路径上的理由**不是“严重性”，而是宿主的卡片正文会自动回显 `args.command`（计划 §1 事实表；`design/p2-audit-v2.md` §3 第 9 条只说 `displayReason` 不落盘）。一旦有任何规则把它变成卡片，密钥就出现在屏幕上——这正是 `design/p3-handoff.md` 不变量 4 的底层原因，P3 必须把它从“R3 独占”升级成“任何包含 R3 命中的组合”。

**非 shell 工具的 ask 分支（`r3-secrets.js:35`）也要守住。** 今天 `write`/`edit` 命中 R3 走 `ask` 而不是 deny，依据是“文件写入的卡片不回显正文”（`r3-secrets.js:5-7`、`describe.js:80-81`）。2026-11-16 实测：`write` 一条正文含假 token → **确实弹卡**，审计四事件齐全（`requested` → `delivered`，`approvalRequestId` 有值 → `outcome: "allowed-once"`、`source: "user"` → `executed`），卡片文字是 ask 文案 + “写入后无法撤销”，**不含原文**。**已复核（同日，用户答复）**：卡片**没有预览文件正文**，也没显示路径与提示 → 不构成泄漏通道，`ask` 分支保留。一个次要观察：用户反馈卡片上连路径/提示都没看到，与 `displayReason` 预期不一致，待确认是不是宿主的渲染问题（不影响 R3 的安全判断，但会影响“用户能否看懂自己在批什么”）。

因此 v2 的边界写死为：**`ask` 只允许给“卡片不预览参数正文”的工具**。`write`/`edit`/`apply_patch` 今天满足；如果将来宿主改版让卡片预览 `content`/`patch`，这条分叉立刻失效——那三个工具上的 R3 必须与 shell 一样 clamp 成 `deny`。这条依赖宿主渲染行为，验收时不能只看插件代码，要真弹一张卡看。

**2. 密钥痕迹钳制**

`secretHit === true` 时：

- `auditTarget` 走今天 R3 的分支（只写 `file_path`，或写脱敏后的标签）；
- `payloadOf` 返回 `secret: true`，原文不落盘。

**实测补充（2026-11-16 R3 探针）**：今天 R3 拒绝时 `payloadRef: null` 但**仍写 `payloadSha256`**（对原文算的 `sha256`）+ `payloadBytes`。`write` 的 ask 路径同样如此（`payloadRef: null`、`payloadBytes: 217`、哈希在），说明这不是拒绝路径的个例。对高熵密钥无害，对低熵命中（`password=hunter2`、短内网 token）这等于在盘上留了一个可字典反推的校验值。v2 要求 **R3 命中时 `payloadSha256` 也置 `null`**，只留 `payloadBytes` 表达"拦下了多长的一条"；链完整性由记录自身的 `prevHash` 保证，不依赖 payload 哈希。

**已实现（2026-11-17）**：`dsh-guardrails/lib/audit/v2.js` 的 `writePayload()` 现在三分支——非密钥原样存；`secret && !spill` → `{ref:null, sha256:null, bytes}`；`secret && spill`（observe）→ 脱敏后才可能有哈希，见 §2.6 第 4 条。`payloadSha256` 为 `null` 已由 `test/audit.test.mjs` 与 `test/plugin.smoke.mjs` 各锁一条。

**这两个判断必须从“赢家是 R3”改成“命中过 R3”。** 否则 v2 多命中时，一条命令同时含 token 和 `reg delete`，赢家是 R2c，payload 就把密钥原文写盘了。这是本设计最危险的一处，必须有专门回归断言（§8 第 6 条）。

**3. 静默钳制**

`quiet` 的介入条件（`dsh-guardrails/lib/finalize.js` 的 `applyWorkspaceQuiet`）从“赢家是 R2 且无 severity”收紧为：

```
verdict.mode === 'ask'
&& verdict.rule === 'R2'
&& verdict.severity === undefined
&& 没有任何一条 reason 比 ask 更严（rank > 2），且所有 rank === 2 的 reason 都是非 critical 的 R2
&& verdict.secretHit !== true
```

否则“在 `_scratch` 删个文件、顺手带上 token”会被静默放行。

**2026-11-17 修正**：原来的写法要求 `reasons` 里**每一条**都是普通 R2，于是任何命中的 `observe` 条目都会把 quiet 关掉——想看住某个目录，反而把这个目录的静默放行取消了，两个特性互相抵消。现改为“更弱的命中不构成否决”：`observe`/`allow` 是“记录”，不是“必须弹卡”。`v2-quiet-survives-observe-entry` 与 `v2-entry-deny-beats-quiet` 两条契约用例把两侧都钉住。

**4. 脱敏钳制（observe 专用，配失败关闭）**

observe 命中 R3 时，payload 必须先脱敏再落盘：

- 用**与检测同一份** `DEFAULT_SECRETS`（外加 `rules.secrets.patterns`）把命中片段替换为 `<redacted:LABEL>`，LABEL 取 `labelFor()` 的规则名（如 `<redacted:openai>`），**不保留命中长度**——长度本身就是侧信道；
- 脱敏在**截断之前**执行（否则截断点上的半截密钥会逃过替换）；
- 落盘前**再扫一遍脱敏结果**：仍有任何 pattern 命中 → 整条 payload 不写（`payloadRef: null`、`payloadSha256: null`），只留 `redacted: ["openai"]` 与 `payloadBytes`；
- `payloadSha256` 对**脱敏后**文本计算，文档写明（否则哈希就成了原文的校验通道）。

理由：检测与脱敏不可能永远同构（大小写变体、多规则重叠、截断边界），所以“脱敏”不能当唯一防线，必须配“复扫失败即不写”的失败关闭。

**已实现（2026-11-17）**：`dsh-guardrails/lib/redact.js` 的 `redactSecrets(text, extraPatterns)` → `{ text, labels, clean }`；`writePayload()` 在 `secret && spill` 分支调用它，`clean === false` 时整条不写。注意一处与设计初稿的偏离：`key=value` 形状把**整段**替换成占位符（键名也一起走），理由是"判断哪一部分只是键名"需要启发式，而启发式在脱敏器里就是漏点；`test/redact.test.mjs` 锁住了这个行为。

### 2.7 observe 的审计事件

建议新增第六个事件 `observed`（`design/p2-audit-v2.md` §4.1 的表要同步加一行）：

```json
{"v":2,"id":"...","event":"observed","ts":"...","tool":"pwsh","rule":"R2","mode":"observe",
 "reasons":[...],"facts":{...},"payloadRef":"...","hash":"..."}
```

- 不写 `outcome`：observe 没有“决定”，只有“记录”。
- `payload` **脱敏后**照写（见 §2.6 第 4 条）；脱敏后复扫仍有命中则整条不写（`payloadRef: null`）；仍受 `audit.maxPayloadBytes` 约束（顺序：先脱敏、后截断）。
- 命中 R3 时另带 `secretLabel`（如 `openai-key`），不带原文、不带原文长度以外的任何还原线索。
- 报告脚本无需改代码：`dsh-guardrails/tools/audit-report.mjs:116` 是通用遍历，新事件自动进 `--stats` 分桶。

替代方案（见 §10 待拍板 3）：复用 `allowed` + `observe: true` 字段，少一个事件但有歧义。

### 2.8 兼容与升级陷阱

1. `version` 缺失或 `=1` → **逐条短路返回**，返回值字节不变；128 条现有测试是回归基线。`=2` 才走收集排序。
2. 两个版本**共用同一批匹配器**（R3/R1home/R1self/R2c/R2d 各自模块不改判定逻辑），只差组合方式；否则会出现“只修了一条路径”的 bug。
3. **`mode:"allow"` 陷阱**：今天 `dsh-guardrails/lib/rules/r2-destructive.js:63` 会把 allow 夹成 ask（写了不生效）。v2 里 allow 合法 → 同一份配置文件升级后**静默变宽**。对策：`allow` 仅在 `version:2` 作为规则 `mode` 合法；v1 文件里出现就写 `config-invalid` 并按 ask 处理。
4. 升级后 `~/.dsh/guardrails/policy.json` 仍是 `version:1` → **行为零变化**；用户手动改成 `2` 才启用 v2。这次编辑本身会撞 R1 弹卡（`~/.dsh` 下），正好在审计里留下“谁在什么时候开启了 v2”。
5. `enabled: false` 仍是总开关，优先级最高，不受版本影响。

---

## 3. 自保护

### 3.1 放在哪一层

放在同一个 `tools/pre-execute` 闸门（`dsh-guardrails/index.js:277`），新增匹配器 `dsh-guardrails/lib/rules/r1-self.js`，归入 **R1 带**：票面 `rule: 'R1'`，另加 `sub: 'self'`。

**为什么不是新规则 ID `R4`**：审计 `rule` 字段（`design/p2-audit-v2.md` §4.3 只列 `R1｜R2｜R3`）、i18n 文案键、报告脚本统计都按三条红线建；新增第四色会让“三条红线”这个心智模型和全部历史统计口径一起破。

**为什么不能是沙箱**：插件没有那个权限面，计划 §10 也明确不做。自保护是**提高成本**，不是边界；文档必须原句写清。

### 3.2 保护面

| 受保护根 | 来源 | 覆盖 |
|---|---|---|
| `~/.dsh` | 既有 `protectDshHome.roots` | `policy.json`、审计目录、profile、插件安装副本 |
| `~/.agents` | 同上 | 同名规则 |
| 插件源码目录 | `selfProtect.paths`，默认空 → 自动 = `index.js` 所在目录 | `rules.js`、`lib/`、`i18n/`、`index.js` |

`~/.dsh` 已经覆盖计划 §6.2 要求的 `policy.json`；插件根覆盖 `i18n/`。因此**不需要第三套机制**。

自动根的算法：`realpathSync(dirname(fileURLToPath(import.meta.url)))`，失败回退到未解析路径；结果必须是小写、绝对、反斜杠归一（复用 `dsh-guardrails/lib/rules/kit.js:96-106` 的 `expandPath` 语义）。启动时断言该根以 `dsh-guardrails` 结尾，不满足则写一条 `config-invalid` 并在日志里点名——静默失效的护栏等于没有护栏。

### 3.3 匹配形状（三条，全部复用现有判定）

1. **`PATH_TOOLS` 写入受保护根**：`pathOf(args)` → `expandPath` → `isUnder(target, roots)`。沿用 `dsh-guardrails/lib/rules/r1-home.js:42-51`。
2. **shell 命令**：路径出现 + 写动词在 400 字符内。现有 `dsh-guardrails/lib/rules/kit.js` 的 `mentionsHomeNearWrite` 是 `.dsh/.agents` 专用正则，已泛化成 `mentionsPathNearWrite(command, roots)`：把“路径提及”换成对每个根做字符串包含判断（根已小写归一）。
   **2026-11-17 修正（实测）**：原先要求“同一语句”，结果两次真实的 `policy.json` 写入（`$p = Join-Path … '.dsh\…'; …; Set-Content $p`）**一条审计记录都没有**——路径在赋值语句、写动词在后面，语句边界正好切断了匹配。现改为“400 字符窗口内”，并给 `WRITE_VERBS` 补了 `writealltext|writeallbytes|writealllines|appendalltext|writefilesync|createfile`（`[System.IO.File]::WriteAllText` 原来根本不算写动词）。代价是“顺带提一句 `~/.dsh`、400 字符内又有写动词”的命令会多一张卡；R1 是 ask 档，这个代价可以接受。
3. **`plugin_manager`**：已在 `alwaysAskTools`（`dsh-guardrails/lib/rules/r1-home.js:31-40`），安装/升级/卸载自动弹卡。

命中后 `facts.protectedHit = true`（`dsh-guardrails/lib/describe.js:93` → `seg.protected`），卡片文案说明“这是护栏自身源码，不是 DSH 家目录”。为此 `dsh-guardrails/index.js:334` 传给 `collectFacts` 的 `roots` 必须合并成全集（home + self），否则文案层看不到自保护命中。

### 3.4 拦不住什么（必须写进文档，不能写进“已保护”）

- 用户本机手工编辑、任何非 DSH 进程、插件进程内的 `fs` 写（计划 §9 最后一行已承认）。
- `apply_patch`（参数里没有路径字段，见 §0.1）——实现前确认参数形状，若确认无路径，则对 `apply_patch` 增加“patch 文本里出现受保护根 + `*** (Update|Add|Delete) File:`”的判定。
- 经由 shell 的编码/拼接绕过：`powershell -enc`、`& (...)`、变量拼路径。与 §9 “正则被变形绕过”同类，靠契约表登记，不靠“应该没事”。
- Windows 路径变形：8.3 短名（`DSH-GU~1`）、段尾点、`\\?\` 前缀。只做一条低成本归一（段尾去点去空格），其余明确不追，登记为 `knownGap`。

### 3.5 能否被 policy 关掉

**已定（§10.1）：`selfProtect.mode` 只接受 `ask | deny`，不接受 `off` 与 `allow`。**
**2026-11-17 追加：`version: 2` 下追加接受 `observe`**，作为开发期临时约定——改护栏自身源码不弹卡，只记 `observed`，
改完可回看；发布前必须改回 `ask`（`dsh-guardrails/policy.schema.json` 的 `selfProtect.mode` enum、
`lib/policy/validate.js` 的 `self-protect-not-disableable` 与 `observe-requires-v2` 是三道门）。

理由：一个能被“它保护的那个文件”关掉的开关，不是护栏。agent 只要说服用户批准一次 `policy.json` 编辑，重启后自保护就没了。想彻底关，改代码或加环境变量，属于显式运维动作，且会留痕。

若将来允许 `off`，则必须配：每次 `off` 生效时写一条显式告警事件 + 卡片文案明说“本次已关闭护栏自保护”。

---

## 4. CLI：`check`

### 4.1 调用形态

```powershell
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"

& $node dsh-guardrails/tools/check.mjs --tool pwsh --args '{"command":"Remove-Item -Recurse D:\\work\\dist"}'
& $node dsh-guardrails/tools/check.mjs --tool pwsh --args '{...}' --cwd 'D:\work\proj' --json
& $node dsh-guardrails/tools/check.mjs --policy 'D:\tmp\p.json' --validate
Get-Content args.json -Raw | & $node dsh-guardrails/tools/check.mjs --tool pwsh --args -
```

计划 §6.3 写的是 `dsh-guardrails check --tool … --args …`：给 `package.json` 加 `"bin": { "dsh-guardrails": "./tools/check.mjs" }` 即可在全局安装场景成立；本机未全局安装时走 bundled node（`npm` 不在 PATH，见 `design/p3-handoff.md` §3）。脚本同时接受 `check` 作为第一个位置参数以便两种形态都能用。

### 4.2 退出码语义

| 退出码 | 含义 | 对应 decision |
|---|---|---|
| `0` | 放行 | `allow` / `observe`（含 quiet 命中） |
| `2` | 需审批 | `review` |
| `3` | 拒绝 | `block`（含 critical、R3 shell） |
| `1` | 用法错误、策略文件无效、内部异常 | — |

**`1` 绝不能表示放行**：CI 里一条坏策略不能因为“解析失败就当没事”而变绿。这条要进 README。

### 4.3 一致性约束

- CLI **必须调同一个** `evaluate()`；否则契约测试测的是另一套代码，测了也白测。
- CLI 需要 `cwd` 才能复现 `quiet`；提供 `--cwd`，未提供时用 `process.cwd()` **但只在 CLI 里**。运行时 `dsh-guardrails/index.js:242-252` 的 `resolveCwd` 刻意不认 `process.cwd()`（那是宿主安装目录），注释里已说明；CLI 是给人/CI 用的，语境不同，要在 `--help` 里写清。
- CLI 不写审计、不刷心跳，纯函数式；`--json` 输出 `{decision, exitCode, winner, reasons, policyVersion, facts, cwd}`。
- `--validate` 只做 schema + 语义校验（§6），用于“保存前先验”，避免改坏策略后重启才发现。

---

## 5. 契约测试：一张表，两个 runner

### 5.1 表

`dsh-guardrails/test/fixtures/contract-cases.json`：

```jsonc
{ "id": "R2-delete-recursive", "tool": "pwsh",
  "args": { "command": "Remove-Item -Recurse D:\\work\\dist" },
  "expect": { "decision": "review", "rule": "R2", "exitCode": 2 } }

{ "id": "bypass-enc", "tool": "pwsh",
  "args": { "command": "powershell -enc SQBFAFgA" },
  "expect": { "decision": "allow", "exitCode": 0, "knownGap": true,
              "note": "编码载荷不可读，登记不修" } }
```

字段：`id / policy?（省略=默认）/ tool / args / env? / expect{decision, rule?, severity?, exitCode} / knownGap? / v2Only? / note?`。

### 5.2 两个 runner

- `dsh-guardrails/test/contract.test.mjs`：断言 verdict（`decision`、`rule`、`severity`）。
- `dsh-guardrails/test/cli.test.mjs`：对同一份表断言 CLI 退出码 + `--json` 的 `decision`。

这样“CLI 退出码在 CI 中可用”是被证明的，不是被声明的；也顺带保证 CLI 与运行时不会漂移。

### 5.3 覆盖要求

| 类别 | 最少用例 |
|---|---|
| R1 三形状（path / shell / alwaysAskTools） | 6 |
| R2c 每个 category（disk/boot/systemfiles/permissions/registry/custom） | 6 |
| 只读排障（`diskpart list disk`、`bcdedit /enum`、`reagentc /info`、`vsscan`） | 4 |
| R2d 各模式族（删除/移动/robocopy/format/git/reg/sc/schtasks/dism/chkdsk） | 12 |
| R3 各标签 + shell vs 文件写 | 8 |
| quiet 开/关、目录、`.git`、工作区外、不可解析变量 | 7 |
| entries（允许条目、收窄条件、无 when 被拒） | 5 |
| 已知绕过（变量拼接、`cmd /c`、`powershell -enc`、`& (...)`、管道、`mshta`、`start /b`、`for /f`） | 8+ |

`knownGap: true` 是**诚实标记**：断言“当前确实放行”。未来修好时手动翻牌，而不是把期望值改成“拦住”然后让测试一直红着。

### 5.4 落地状态（2026-11-16，第 ① 步完成）

- 文件：`dsh-guardrails/test/fixtures/contract-cases.json`（64 条用例）+ `dsh-guardrails/test/contract.test.mjs`（2 类断言：表自检 + 逐条 verdict）。已加入 `package.json` 的 `scripts.test`。
- 实测：`test/contract.test.mjs` → **61 pass / 5 skipped / 0 fail**；全套 9 个文件 189 条全绿（其余 8 个文件 128 条未变）。
- 覆盖对照 §5.3：R1 7、R2c 8（含 `critical.mode: ask` 与 `off` 两个降级用例）、只读排障 4、R2d 17、R3 8、quiet 8、已知绕过 8、entries/observe/selfProtect 5（`v2Only`，跳过）。
- `knownGap` 的 8 条今天全部断言“确实放行”，包括：`powershell -enc`、`start /b format`、`& ('Remove' + '-Item')`、`for /f … do del`、`mshta` 引号内载荷、`apply_patch` 只有 patch 文本、`..\Admini~1\.dsh` 8.3 父目录名、base64 管道。
- quiet 用例需要一个“存在的单文件”才能命中：`collectFacts` 的 `count` 只在 `exists === true && !isDir` 时为 1（`dsh-guardrails/lib/facts.js:289-294`），所以表里新增可选字段 `io: {type:"file"}`，runner 把它换成 stat stub，避免让表依赖运行机器上的文件。
- quiet 的接线（`index.js:343-351`）在 runner 里是按同一顺序调 `collectFacts` + `decideQuiet` 复现的；第 ③ 步抽出 `finalize()` 后应改为调用它，而不是继续复现顺序（已在本文件开头注明）。

### 5.5 建表过程中暴露的三个问题

1. **entries 命中时 `verdict.rule` 填什么？** 表里两条 entries 用例暂时没有 `expect.rule`，只有 `v2Only` 例外允许缺省。§2 只规定了 band 顺序与 `entryId` 进 `reasons[]`，没规定赢家 `rule` 字段取值。实现前必须定：建议 `rule: "E"` + `entryId`，避免伪装成 R2 污染审计统计与 i18n 文案。
2. **quiet 依赖“目标真实存在”**：`Remove-Item` 一个不存在的路径永远不静默（`count === undefined`）。这是当前有意行为（“证明它只有一个文件”），但文档没写；`docs/DETAIL.md` 需要补一句，否则用户会以为“同一个命令有时弹卡有时不弹”是 bug。
3. **critical 与 R2d 对“引号内载荷”不对称**：`mshta "…cmd /c del C:\Windows\help.txt…"` 会被 critical 的系统目录规则拦下（`quotedSegments` 会展开引号内文本），但同样的引号内 `rd /s /q D:\work\tmp` 不会被 R2d 拦。不是 bug 也不是设计，是两条匹配器写法不同；契约表把这一参照实固定住了（`gap-mshta` 用非系统路径，`R2c-del-windows-system` 用系统路径）。

---

## 6. `policy.schema.json` 与启动校验

- 新增 `dsh-guardrails/policy.schema.json`（Draft 2020-12），每层 `additionalProperties: false`——直接治 `workspaceQuite` 这类拼写错（`dsh-guardrails/index.js:80-91` 的深合并会把未知键原样带过，静默失效）。
- **不引新依赖**（决策：无构建链/无依赖）：`dsh-guardrails/lib/policy/validate.js` 手写校验器，只支持用到的子集（`type / enum / required / properties / additionalProperties / items / pattern / oneOf / minItems / minLength / minimum`），runtime、CLI、测试共用一份。schema 是唯一事实来源，校验器读它。
- 语义校验（schema 表达不了的）放同一模块：
  - `mode: "allow"` 仅 `version: 2` 合法（§2.8-3）；
  - `entries[].mode === "allow"` 必须有非空 `when` 且至少一个收窄条件；
  - `rules.critical.mode` 不接受 `observe`；
  - `entries[].id` 唯一；
  - `when.cwdUnder/targetUnder` 必须是绝对路径、不含 `..`、不含通配符。
- 装载行为改写 `dsh-guardrails/index.js:163-182`：非法 → 保留上一份好策略；从未有过好的 → 用 `DEFAULTS`（更严，方向安全）；`ctx.logger.warn` 一条（每类错误只报一次）+ 审计 `config-invalid` 带 `errors[]`（事件类型已存在，`dsh-guardrails/index.js:359-365` 用过）。当前这段是**静默**吞掉解析失败的，违反计划 §8 第 4 条“失败要响”。
- 新增 `dsh-guardrails/test/policy-schema.test.mjs`：示例策略通过；每个已知坏样本被拒且报错路径精确到字段。

---

## 7. 交付分批（1.5.0，内部五步）

| 步 | 内容 | 为什么这个顺序 | 回滚 |
|---|---|---|---|
| 1 | 契约表 + `test/contract.test.mjs`（只测现状，含 `knownGap`）**（已完成 2026-11-16，见 §5.4）** | 先把今天的行为钉死，后面每步都能证明“没变” | 删文件 |
| 2 | `lib/rules/r1-self.js` 自保护 + 合并 roots 文案 + `policy.schema.json` / `validate.js` / 启动校验 **（已完成 2026-11-16，见 §7.1）** | 小而加性；先于引擎重构落地 | 还原两个文件 + 重启 |
| 3 | 引擎 v2（收集 + rank + `reasons[]` + entries + observe），`version:1` 完全走老路径 **（已完成 2026-11-17，见 §7.2）** | 最大一块，前面已有护栏 | 还原 `rules.js` + 重启 |
| 4 | `tools/check.mjs` + `test/cli.test.mjs` + `bin` **（已完成 2026-11-17，见 §7.3）** | 依赖第 3 步的返回值形状 | 删文件 |
| 5 | 文档：`ARCHITECTURE.md` / `DSH-API.md` / `POLICY.md` 双语、`examples/policy/` 模板 + 测试、README 重写、本文转正 **（已完成 2026-11-17，见 §7.6）** | 计划 §6.2 第三条是文档交付项 | 还原 md |

版本与 tag：全部完成后 `package.json` 升 **1.5.0**，打 `v1.5.0` + `p3`（annotated，写清验收日期）；每步一个小提交，消息写“改了什么、为什么”。`design/p3-handoff.md` §0 的版本/提交/tag 快照在收口时一并更新。

### 7.1 第 ② 步落地状态（2026-11-16）

新增 / 改动（全部在 `dsh-guardrails/`）：

| 文件 | 改动 |
|---|---|
| `lib/rules/r1-self.js`（新） | `pluginRoot()`（`realpathSync` + 回退）、`assertSelfRoot()`、`selfRoots()`、`evaluateR1Self()`；三条匹配形状 |
| `lib/rules/kit.js` | 抽出 `segmentNearWrite()`；新增 `mentionsPathNearWrite(command, roots)`（带 `ROOT_TAIL` 边界判定，`dsh-guardrails2` 不命中） |
| `lib/policy/validate.js`（新） | 读 schema 的手写校验器 + 语义校验；`describeErrors` / `errorSignature` |
| `policy.schema.json`（新） | Draft 2020-12，每层 `additionalProperties:false`；`rules.selfProtect` 的 `mode` 只接受 `ask`/`deny` |
| `rules.js` | R1 带内，home 之后接 `evaluateR1Self`；头注释同步 |
| `index.js` | `DEFAULTS.rules.selfProtect = { mode:'ask', paths:[] }`；`loadPolicy` 校验失败保留上一份好策略并报 `config-invalid`；`roots` 合并 self；`fieldsFor` 透传 `sub`；启动 `assertSelfRoot` |
| `package.json` | `files` 加 `policy.schema.json`（漏了会让打包后 `validate.js` 导入即抛）；`scripts.test` 插入两个新测试 |
| `test/self-protect.test.mjs`（新，17 条） | 自动根 / 断言失败 / 三类形状 / 前缀不误伤 / 大小写 / patch 文本 / 卡片文案 |
| `test/policy-schema.test.mjs`（新，7 条） | 今日配置与默认值形状通过；21 个坏样本精确到字段；`describeErrors` 截断 |
| `test/fixtures/contract-cases.json` | `v2-self-protect-plugin-source`（写死本机路径）换成 4 条可移植用例：extra path / shell write / shell read / apply_patch |
| `test/contract.test.mjs` | `DEFAULT_POLICY` 补 `selfProtect`（镜像 DEFAULTS）；skip 文案去掉 selfProtect |
| `docs/DETAIL.md` / `docs/DETAIL.zh.md` | 规则表加 R1 self 行；自保护"只能收紧/不是沙箱"；schema 校验与"坏文件保留上一份好策略"；限制清单 |

实测：全套 **11 个文件 217 条全绿**（27+22+15+3+15+11+19+17+7+65+16，contract 里 4 条 `v2Only` 仍跳过）。离线核对：`~/.dsh/guardrails/policy.json`（`version:1`）通过校验；`pluginRoot()` 经 profile junction 解析为 `D:\work\guardrails\dsh-guardrails`，`assertSelfRoot` 通过。

实现中确定的三条（设计文档未写死，按"更安全的一侧"落地）：

1. **`version: 2` 暂时被拒**，报 `unsupported-version`（"engine v2 is not implemented yet"）。理由：现在放行 v2 会让 `allow` 与 `entries` 被静默忽略，正是 §2.8-3 要防的静默变宽。第 ③ 步把 `SUPPORTED_VERSION` 改成 2 并补 v2 行为。
2. **`apply_patch` 不再留空**：`r1-self.js` 扫描所有字符串参数里的 `*** (Add|Update|Delete) File: <path>`，命中受保护根即弹卡。参数形状仍未知，但"只有 patch 文本"这条路径已封。R1home 的同类漏口（`gap-apply-patch-delete-dsh`）**未**修，仍登记为 `knownGap`。
3. **`selfProtect.mode` 的双重门禁**：schema 的 `enum` 拒绝 `off`/`allow`，`evaluateR1Self` 里也再判一次 `mode !== 'ask' && mode !== 'deny' → null`。绕过校验的手写策略同样关不掉。

**重启后首测暴露的三个问题（2026-11-16，已修前两个）**

1. **相对路径绕过（真漏洞，已修）**：`write` 传 `"file_path": "dsh-guardrails\\probe.txt"` 时 `expandPath` 不解析相对路径，`isUnder` 拿到的是相对串 → 自保护与 R1home 同时漏。修法：`expandPath(input, env, base)` 增加 `base` 参数，`index.js` 把 `resolveCwd(exec).cwd` 作为 `env.CWD` 传进 `evaluate()`；`facts` 的 env 也带上。测试：`test/self-protect.test.mjs` 两条（有 cwd 命中 / 无 cwd 不命中）。
2. **审计写入器有字段白名单（真 bug，已修）**：`lib/audit/v2.js:140-170` 的 `append()` 逐字段构造记录，`sub` 不在表里 → 自保护命中时审计里看不到 `sub`（live 首条记录即如此）。已补 `sub`，并在 `test/plugin.smoke.mjs` 增加 mount 级断言（记录含 `sub: 'self'` 且 `facts.protectedHit === true`）。教训：新增判定字段要同时改 `fieldsFor` 和 `AuditLog.append`，只改前者会被静默吞掉。
3. **shell 里的相对路径提法（已知缺口，未修）**：`Set-Content dsh-guardrails\x.txt` 这种命令里没有绝对根，`mentionsPathNearWrite` 不匹配 → 自保护漏；同一命令经 `pwsh` 沙箱反而被 OS 拒绝（DSH 沙箱不放行插件目录写入），属于外部兜底而非本护栏。登记为 `knownGap`。

live 首测证据（2026-11-16 23:13，重启后）：`write` 绝对路径写入插件目录触发审批卡，卡片正文含“受保护目录”，审计四事件齐全（`requested → delivered → outcome: allowed-once → executed`），`facts.protectedHit: true`。

### 7.2 第 ③ 步落地状态（2026-11-17）

新增 / 改动（全部在 `dsh-guardrails/`）：

| 文件 | 改动 |
|---|---|
| `rules.js` | 重写为三部分：`RANK = { deny: 3, ask: 2, observe: 1, allow: 0 }`、`MAX_REASONS = 8`；`evaluate()` 按 `policy.version === 2` 分派；`evaluateV1` 是旧的逐带短路（字节不变），`evaluateV2` 收集 R3→R1home→R1self→R2c→R2d→entries 的候选后按 rank 取赢家 |
| `lib/rules/r3-secrets.js` | 加 `opts` 与 `modeForV2()`：`observe` 保持 observe；shell 命令只要不是 observe 仍一律 `deny`（卡片回显命令）；非 shell 才可能 `allow` |
| `lib/rules/r1-home.js` / `lib/rules/r1-self.js` | 加 `opts`：v2 下返回配置的 mode（self 的 schema 仍只允许 ask/deny，运行期门禁再加一层） |
| `lib/rules/r2-destructive.js` | 拆出 `evaluateR2Parts()` → `{ critical, destructive }`，让两条带各自参与排序；`evaluateR2()` 保留为 critical 优先，v1 不受影响 |
| `lib/rules/entries.js`（新） | `evaluateEntries()`：工具匹配 + `when` 三条件 AND（`cwdUnder` / `targetUnder` / `commandMatches`），返回 `{ rule: 'E', entryId, mode, reason }` |
| `index.js` | `auditTarget()` / `payloadOf()` 改看 `secretHit === true`（不只是赢家 R3）；`fieldsFor` 透传 `entryId`/`reasons`；quiet 增加“reasons 全是非 critical 的 R2 且 `!secretHit`”；新增 `observe` 分支（写 `observed` 事件后 `next()`） |
| `lib/audit/v2.js` | 记录白名单补 `entryId` / `reasons` |
| `lib/describe.js` + `i18n/*.json` | `rule: 'E'` 渲染成人话：`action.entry.deny/ask/observe/allow`（zh “自定义规则 {id} 禁止此调用 / 要求确认 / 命中，仅记录 / 允许此调用”） |
| `lib/policy/validate.js` | `SUPPORTED_VERSION = 2`；`allow-requires-v2` 只在 v1 触发；新增 `critical-mode-invalid`、`observe-requires-v2` |
| `policy.schema.json` | 四个规则块的 `mode` enum 加 `observe`（critical 的取值由语义校验兜住） |
| `test/engine-v2.test.mjs`（新，17 条） | v1 输出不变、rank 与并列、entries 四种 mode、when 合取与路径段比较、R3 的 shell 钳制、`secretHit` 在更严赢家下仍为真、E 卡片文案、两份语言包键齐全 |
| `test/contract.test.mjs` / `test/fixtures/contract-cases.json` | 5 条 `v2Only` 转正；新增 `cwd` 字段；quiet 门禁镜像 index.js；表自检对非 allow 结论强制要求 `rule` |
| `test/plugin.smoke.mjs` | 追加 6 条 mount 级 v2：E 拒绝的审计、E 卡片中文、observe 的 `observed` 事件、observe 密钥不落盘、密钥+deny 时 payload 不写、allow 记 `allowed` |

实测：**13 个文件 269 条全绿**（audit 11、contract 69、critical 15、describe 17、dry-run 10、engine-v2 17、facts 25、policy-schema 8、quiet 19、replay 3、rules 27、self-protect 19、smoke 29），`contract` 的 4 条跳过已归零。

实现中确定的三条：

1. **R3 的 `allow` 只在非 shell 生效**：`rules.secrets.mode = "allow"` 下，`write` 里含 token 也放行并记 `allowed`；但 shell 命令仍被钳成 `deny`（`modeForV2`），因为卡片正文会回显 `args.command`。这条钳制不因配置让步。
2. **`observe` 事件只属于 v2**：`version: 1` 出现 `observe` 直接 `observe-requires-v2`（v1 里它会被夹成 ask，静默改变语义）。
3. **`entries` 的 `cwd` 必须归一化**：`when.cwdUnder` 用 `expandPath(env.CWD)` 后的串做 `isUnder` 比较，按路径段而不是字符串前缀（`proj2` 不会被 `proj` 命中）——首版忘了归一化，测试立刻抓到。

### 7.3 第 ④ 步落地状态（2026-11-17）

新增 / 改动（全部在 `dsh-guardrails/`）：

| 文件 | 改动 |
|---|---|
| `tools/check.mjs`（新） | 参数 `--tool` / `--args`（`-` 读 stdin）/ `--policy` / `--cwd` / `--json` / `--validate` / `--help`；位置参数 `check` 兼容 `dsh-guardrails check`；导出 `run(argv, io)` 供测试直接调用（`stdout`/`stderr`/`stdin`/`env` 注入） |
| `lib/finalize.js`（新） | `factRoots(policy, env)` 和 `applyWorkspaceQuiet({ policy, call, verdict, facts, cwd })`：把“普通 R2 ask 降成工作区静默放行”这段判定从 `index.js` 抽出来，宿主、契约 runner、CLI 三处共用 |
| `lib/policy/merge.js`（新） | 把 `index.js` 里的 `merge()` 挪出来，CLI 与宿主用同一份合并规则 |
| `index.js` | 改为调用 `factRoots` / `applyWorkspaceQuiet`；`DEFAULTS` 改为 `export`（CLI 复用同一份默认策略）；删除本地 `merge` |
| `test/cli.test.mjs`（新，77 条） | 表里除 `io` 那一条外全部用例各跑一遍 CLI，断言 `decision` + `exitCode`（+ 可选 `winner.mode`）；另加 8 条 CLI 自身契约：坏参数、未知参数、缺 `--tool`、`--validate` 好/坏、无效策略不当默认值、`--args -`、缺策略文件回退默认值 |
| `test/contract.test.mjs` / 契约表 | 新增可选 `expect.mode`（只允许 `observe`，且决策必须是 `allow`）；两条 observe 用例登记；表自检同步 |
| `package.json` | 加 `"bin": { "dsh-guardrails": "./tools/check.mjs" }`；测试链补 `test/cli.test.mjs`，并补回**漏掉的 `test/engine-v2.test.mjs`** |

实现中确定的四条：

1. **决策词只有三个**（`allow` / `review` / `block`），`observe` 算 `allow`（退出码 0）。要区分两者看 `winner.mode`，契约表用可选的 `expect.mode` 钉住——否则一条 `observe` 静默变成普通 allow（记录消失）不会有测试发现。
2. **无效策略在 CLI 里是错误（退出码 1），不静默回退**：宿主的“保留上一份好策略”对常驻进程是对的，对一次性提问会把拼写错误藏起来。
3. **`--cwd` 只属于 CLI**：只有它允许用 `process.cwd()` 兜底；宿主对工具调用从不这样猜目录。
4. **`env` 是测试注入点，不是命令行开关**：契约表按虚构用户主目录（`C:\Users\Tester`）回放，CLI 需要同样的环境；做成 flag 就等于让一次调用假装跑在别人的机器上。

实测：**14 个文件 353 条全绿**（rules 29、facts 25、describe 17、replay 3、critical 15、audit 11、quiet 19、dry-run 10、self-protect 21、policy-schema 9、engine-v2 17、contract 70、cli 77、smoke 30）。CLI 的唯一跳过是 `quiet-enabled-eligible`（表用 `io` 伪造文件存在，CLI 走真实文件系统，跳过原因写在 runner 里并由一条自检钉住“只能跳这一条”）。

**过程中发现的一个真问题**：`test/engine-v2.test.mjs` 从来没进过 `package.json` 的测试链——17 条 v2 测试写了、跑过，但 `npm test` 不跑。这类“存在但没接上”的测试比没有更糟，因为它让人以为被覆盖了。

### 7.4 第 ⑤ 步之前的缺口修复（2026-11-17）

通读本文与代码后发现的“文档写了、代码没写”的四处，已全部补齐：

| 缺口 | 文档位置 | 实现 |
|---|---|---|
| G1 observe 下的 R3 payload 从未脱敏（`secret` 分支直接 `ref: null`，全库无 `redact`） | §2.6-4、§2.7 | 新增 `lib/redact.js`：`redactSecrets(text, extraPatterns)` → `{ text, labels, clean }`；`writePayload()` 的 `secret && spill` 分支先脱敏再截断，`clean === false` 时整条不写；`append()` 白名单加 `redacted` |
| G2 密钥记录仍写原文 `sha256` | §2.6-2、§9 风险 19 | `secret && !spill` → `{ref:null, sha256:null, bytes}`；`test/audit.test.mjs`、`test/plugin.smoke.mjs` 各锁一条 |
| G3 `reasonsTruncated` 从未置位 | §2.5 | `rules.js` 在 `candidates.length > MAX_REASONS` 时置 `reasonsTruncated: true`；`fieldsFor()` 与 `lib/audit/v2.js` 白名单各加一行；`engine-v2.test.mjs` 与 `plugin.smoke.mjs` 各一条（10 条 observe 条目 → 8 条 reasons + 截断标记） |
| G4 `reasons[]` 字段名与文档不符 | §2.5 | 文档已按实现改正（`mode` 而非 `decision`，多 `sub`，无 `reason`） |

一处与设计初稿的主动偏离：`key=value` 形状**整段**替换（键名也一起走），理由是"判断哪一部分只是键名"需要启发式，而启发式在脱敏器里就是漏点；`test/redact.test.mjs` 锁住该行为。

实测：`lib/redact.js` 9 条、`test/plugin.smoke.mjs` 32 条、`test/engine-v2.test.mjs` 19 条、`test/audit.test.mjs` 11 条；**15 个文件 370 条全绿**（rules 34、facts 26、describe 17、replay 3、critical 15、audit 11、quiet 19、dry-run 10、redact 9、self-protect 22、policy-schema 9、engine-v2 19、contract 70、cli 77、smoke 32）。

### 7.5 `cwdUnder` 的真实来源（2026-11-17 live 验收发现）

live 验收第 ③ 步（`entries` + `cwdUnder`）**静默不命中**：审计记录里 `cwd` 与 `cwdSource` 都是 `null`，`reasons` 只有 `R2`。查证结果：

- 宿主 `ToolExecutionInput`（`app.asar` 内 `docs/subsystems/tools.md` §Execution）**没有 cwd 字段**；cwd 随 session 走。
- 实测（2026-11-17，诊断写进审计 `detail`）：session 上没有 `meta`（为 `null`）、没有 `cwd`，但有 **`header`**；对应会话库布局 `~/.dsh/sessions/<编码过的 cwd>/session-<uuid>/`（目录名即 `f(header.cwd)`）。
- 因此正确读法是 `exec.agent.session.header.cwd`（`meta.cwd` 与 shell 的 `workdir` 作兜底）。`index.js` 的 `resolveCwd` 原先只读 `session.cwd` → 在本安装里恒为 `null`，`cwdUnder` 条目永不命中且**不报错**。
- 修法两条并列：① `resolveCwd` 按 `session.header.cwd → session.meta.cwd → session.cwd → shell workdir` 取；② 新增 `warnIfCwdRequired(policy, cwd)`——策略里有 `when.cwdUnder` 条目而本次调用拿不到 cwd 时，按 `reportPolicyProblem('cwd-unavailable', …)` 只报一次。
- 诊断方法：把 `session` 的 keys / `meta` / `header` 写进 `config-invalid` 的 `detail`，重启后读一条记录即可定性（本次就是这么找到 `header` 的）；诊断代码用完即摘。
- 附带发现并修掉：`lib/audit/v2.js` 的 `append()` 白名单**丢掉了 `reason` / `detail`**，于是 `config-invalid` 记录只有事件名、查不出成因（早先那两条 BOM 与旧 schema 的记录因此无法自解释）。现在两者在 `input` 提供时落盘，`design/p2-audit-v2.md` 字段表已同步。
- live 复核（2026-11-17 16:34）：记录里 `cwd` 为 `D:\work\guardrails`、`cwdSource: "session"`；临时装进策略的 `cwd-probe` 条目真命中，返回 `Guardrails E: entry "cwd-probe" forbids this call.`，审计 `rule: "E"`、`entryId: "cwd-probe"`、`outcome: "denied"`，无卡。验证后策略已还原、临时文件已删、诊断代码已摘。
- 测试：`test/plugin.smoke.mjs` 新增两条（`meta.cwd` 被记录并驱动 `cwdUnder` 命中；无 cwd 时只写一条 `config-invalid`）。

实测：**16 个文件 394 条全绿**（rules 34、facts 29、describe 17、replay 3、critical 15、audit 11、quiet 19、dry-run 10、redact 9、self-protect 22、policy-schema 10、engine-v2 19、finalize 9、contract 73、cli 78、smoke 36）。

### 7.6 第 ⑤ 步落地状态（2026-11-17，收口）

文档交付按"文件结构 / 运行方式 / 宿主接口 / 自定义策略"四问组织，读的人不必先读设计文档：

| 交付物 | 内容 |
|---|---|
| `dsh-guardrails/docs/ARCHITECTURE.md`（新） | 两棵树（仓库 vs 随包 `files`）逐文件职责、`locale/`（宿主读的插件元数据）与 `i18n/`（卡片文案）分工、分层图、一次调用 8 步、状态表、v1/v2 语义 |
| `dsh-guardrails/docs/DSH-API.md`（新） | 依赖的每个宿主接口 + 假设 + "变了会怎样"；挂载自检（`ctx.on` → `surface`）；升级后五步核查；宿主不给插件做的事 |
| `dsh-guardrails/docs/POLICY.md` / `POLICY.zh.md`（新） | 文件位置与优先级、五种 mode、放宽的四个手段与三档灰度、`entries` 写法、干跑、模板表、`check` 用法、常见错误码 |
| `dsh-guardrails/examples/policy/`（新） | `minimal-v1` / `observe-first` / `tighten` / `relax-with-guard` 四份模板，`$schema` 指向包内 schema |
| `dsh-guardrails/test/examples.test.mjs`（新，4 条） | 四份模板必须过 `validatePolicy`、`$schema` 必须真实存在、`entries` 只出现在 v2、放宽那份必须带 `deny` 捞回 |
| `README.md` / `README.zh-CN.md` | 按 v2 与 1.5.0 重写：文档地图、规则表补 `R1 self` 与 `E`、配置示例改 `version: 2` + `rules.quiet` + `entries`、`check` 一节、审计补 `observed`/脱敏/`reasons`、仓库结构补 `lib/` `docs/` `examples/` `locale/`、测试数改 17 |
| `dsh-guardrails/docs/DETAIL.md` / `DETAIL.zh.md` | 开头加三份文档的互链 |
| `dsh-guardrails/index.js` | 挂载自检：`surfaceProblems` 只探 `ctx.on`，缺则 `surface: "degraded"` + 一次 `logger.error` + 直接返回；正常写 `surface: "ok"` |
| `dsh-guardrails/test/plugin.smoke.mjs` | 两条挂载级用例（ok / degraded） |
| `CHANGELOG.md` / `CHANGELOG.zh-CN.md` | `[Unreleased]` 定为 `[1.5.0] — 2026-11-17`，补文档、模板、`surface` 三条 |

实测：**17 个文件 400 条全绿**（在原 16 个之上新增 `examples.test.mjs` 4 条，`plugin.smoke.mjs` 36 → 38）。

---

## 8. 验收矩阵（可执行条目）

1. **顺序不变**：`dsh-guardrails/test/rules.test.mjs:259-280` 三条 precedence 在 v1、v2 两份策略下都过。
2. **自保护生效**：`write` 改 `D:\...\guardrails\dsh-guardrails\rules.js` → 弹卡；`pwsh` 执行 `Set-Content <插件目录>\rules.js` → 弹卡；`Get-Content <插件目录>\rules.js` → 无卡。
3. **自保护不误伤**：`node test/*.mjs` 全程无卡（插件自身 `fs` 写不受 tools 钩子约束，计划 §9 最后一行）。
4. **observe 不拦但留痕**：`rules.destructive.mode = "observe"` 下删工作区文件 → 无卡、`event: "observed"`、`reasons[]` 完整。
5. **坏策略要响**：把 `policy.json` 改成非法 JSON 或 `"mode": "askk"` → 日志有 warn、审计有 `config-invalid`、行为回退到上一份好策略（不是放行一切）。
6. **密钥不落盘**（regression，最高优先）：构造一条同时含 token 和 `reg delete` 的命令，跑完扫描当天审计目录全部文件与 payload，断言不含密钥子串、且 `payloadRef === null`。
7. **CLI 与运行时一致**：契约表两个 runner 全绿；`--validate` 对坏策略退出 1、对好策略退出 0。
8. **v1 零变化**：`~/.dsh/guardrails/policy.json` 保持 `version:1` 时，128 条既有测试全绿且 `check` 输出与 1.4.0 行为一致。
9. **live 三条**：`Get-Date` 无卡；`cmd /c "reg delete HKLM\SYSTEM\X /f"` 无卡拒绝；一条普通删除弹卡。随后 `node tools/audit-report.mjs --verify` 输出 `chain ok`。
10. **重启核对**：`~/.dsh/guardrails/loaded.json` 的 `version` 与 `package.json` 一致、mtime 在最近几分钟内（pid 不可信）。
11. **observe × R3 脱敏**（§2.6-4）：`rules.secrets.mode = "observe"` 下跑一条含假 token 的 shell 命令 → 无卡、无拦截、`event: "observed"`；扫当天审计全目录，断言 payload 里只有 `<redacted:*>`、不含原 token 任何子串，且 `payloadSha256`（对脱敏文本算）与 `payloadBytes` 存在；把脱敏正则临时改坏后重跑，断言 `payloadRef === null`（失败关闭生效）。**状态（2026-11-17）**：代码已实现、mount 级三条测试已过（`test/plugin.smoke.mjs`）；**宿主 live 已验**（见 §11-6：无卡、payload 只有 `<redacted:openai>`、sha 与文件一致、token 0 次；复扫失败路径 `ref`/`sha` 均 null）。

---

## 9. 风险登记（本文新增，计划 §9 的补充）

| # | 风险 | 触发条件 | 影响 | 缓解 / 验收 |
|---|---|---|---|---|
| 1 | **R3 原文泄漏进 payload** | 多命中且赢家非 R3（token + `reg delete`），`payloadOf` 仍看 `verdict.rule === 'R3'` | 密钥原文落盘，直接违反红线 R3 | `secretHit` 独立布尔 + 全目录子串断言（§8-6） |
| 2 | **优先级反转把密钥推上卡片** | 某条目把含密钥的 shell 命令降为 ask | 卡片正文回显命令，密钥上屏 | shell+R3 一律 clamp 成 deny（§2.6-1），契约表加交叉用例 |
| 3 | **observe 变相关闭 critical** | 把 `rules.critical.mode` 写成 observe | 磁盘级操作只记录不拦 | schema 拒绝；critical 降级只有 `off` |
| 4 | **quiet 被 reasons 放宽** | 静默判定只看赢家 | 含密钥/系统操作的命令被静默放行 | quiet 条件收紧为“全部命中都是非 critical R2”（§2.6-3） |
| 5 | **判定顺序被重构打散** | 收集器把 `readOnlyDiagnostic` 挪到 R2 扫描之后 | `diskpart list disk`、`bcdedit /enum` 被误拦（不变量 2） | 诊断短路留在 R2 内部；`rules.test.mjs:172-180` 继续跑 |
| 6 | **v1/v2 双引擎漂移** | 只在一个分支里修规则 | 同一命令两种结论，审计对不上 | 匹配器共用；契约表在两份策略下各跑一遍（entries/observe 标 `v2Only`） |
| 7 | **`mode:"allow"` 静默变宽** | 老配置里写了 allow（今天被夹成 ask），升级到 v2 | 护栏无提示放松 | allow 仅 `version:2` 合法；v1 出现即 `config-invalid`（§2.8-3） |
| 8 | **schema 误拒正常配置** | 校验器比现实严，或用户多写一个无关键 | 回退 DEFAULTS，卡变多、用户困惑 | 报错精确到字段路径 + `--validate` 预检；`additionalProperties:false` 只用在确定的位置 |
| 9 | **自保护误伤运维** | 维护者用 agent 改插件源码 | 每次改都弹卡（本身是设计目标） | 默认 `ask` 不 `deny`；拒绝时给“手工改 + 重启”的指引 |
| 10 | **自保护路径算错** | 插件经 junction/软链加载；打包后位于 profile 目录内 | 根路径比对失配 → 等于没保护 | `realpathSync` + 小写归一；启动断言根以 `dsh-guardrails` 结尾，失败写 `config-invalid` |
| 11 | **Windows 路径变形绕过** | 8.3 短名、段尾点、`\\?\` 前缀 | 前缀比对失效 | 登记 `knownGap`；只做段尾去点去空格一条归一 |
| 12 | **`apply_patch` 绕过自保护** | 参数只有 patch 文本、无 path 字段 | 直接改 `rules.js` 不弹卡 | 实现前确认参数形状；必要时加 patch 文本扫描（§3.4） |
| 13 | **observe 日志膨胀** | 长期开着 observe，每条命中都落 payload | 磁盘增长、报告变慢 | 受 `audit.maxPayloadBytes` 约束；`--stats` 单列 observed；文档建议“观测一周就关” |
| 14 | **entries 成为新的静默放宽面** | `commandMatches` 写宽，或误以为它是“自定义拦截” | 以为收紧了其实放松 | allow 必须有收窄条件；命中记 `entryId` 可统计；文档明写“policy.json 是受信输入，能改它的人已经能关掉一切” |
| 15 | **审计字段漂移** | 新增 `reasons/entryId/policyVersion`，旧 reader 假设字段集 | 1.4.0 旧记录读不出、或校验误报 | 新字段全可缺省，读侧 `?? []`；补一条旧夹具回归 |
| 16 | **CLI 退出码被误读** | CI 只判 `!== 0` | “需审批(2)”和“策略坏了(1)”混为一谈 | 退出码表进 README；`--json` 给精确判定；`1` 永不表示放行 |
| 17 | **性能回归** | v2 每条调用跑全部匹配器 + facts 的 stat | 工具链变慢，用户感知 | v1 路径保持短路；v2 记录一次实测（1000 次 evaluate 的毫秒数）写进提交说明，不设 CI 阈值（易抖） |
| 18 | **脱敏与检测不同步** | 只改了一侧正则（加新密钥形状时漏改另一侧） | 变体密钥被判定命中、却按旧正则脱敏 → 原文落盘 | 两侧共用同一常量数组，不许各写一份；落盘前复扫，失败即不写（§2.6-4）；fixture 断言“含 `<redacted:` 的 payload 里搜不到原文子串” |
| 19 | **低熵密钥被哈希反推** | R3 命中时仍写 `payloadSha256`（2026-11-16 实测：shell deny 路径 47 B、write ask 路径 217 B，两者 `payloadRef` 都是 `null` 但哈希都在），而命中内容是 `password=xxx` 这类可枚举串 | 盘上留了一个能离线爆破的校验值；ask 路径同样存在 | R3 命中时 `payloadSha256: null`（§2.6-2 实测补充）；只保留 `payloadBytes` |

---

## 10. 决策记录

2026-11-16 三条待拍板项全部落定（见 §10.1），**当前没有未定项**。实现方不得再自行改动这三条；若实现中发现新分歧，另开小节并显式标“未定”，不要夹带进本次改动。

### 10.1 已定（2026-11-16，用户确认）

| 分叉 | 结论 | 依据 |
|---|---|---|
| observe 对 R3 是否生效、payload 怎么写 | **生效**：不弹卡、不拦截、记 `observed`；payload **先脱敏再落盘**，复扫仍有命中则整条不写（§2.6 第 1、4 条） | 密钥规则是误报代价最高、最该先预演的一类；observe 不产生卡片，故“密钥上屏”的成因不成立。用户原话（m00225）：“直接改进，我觉得你这次的建议是对的” |
| R3 落在 `write`/`edit` 这类文件工具上是 `ask` 还是 `deny` | **保持 `ask`（劝阻语义）**，不改 deny | 实测卡片不预览正文、密钥不会上屏；用户选择“劝阻（保持 ask）”（m00371）。代价是密钥可经一次点击落盘 —— 这是明示接受的取舍，不再作为待定项 |
| 自保护能否被 `policy.json` 关掉 | **只能收紧**：接受 `ask`/`deny`，不接受 `off`/`allow` | 能被它保护的那个文件关掉的开关不算护栏。`off` 语义仍保留给内置的 R1home / R2 / R3 三块（m00385） |
| `entries` 是否允许 `mode: "allow"` | **允许，但强制收窄条件**：`when` 非空且至少一个条件；裸 allow 由 schema 拒绝 | 不给 allow 就只能用 quiet 那套硬编码极窄规则；给了则多一个配置级放宽面，所以用 schema 卡住裸 allow（§2.2-3、风险 14）（m00385） |
| observe 记什么事件 | **新增第六个事件 `observed`** | 复用 `allowed` + `observe:true` 会让每个读日志的人都要记得过滤；新增事件成本近零（`lib/audit/v2.js:5-10` 不校验取值、`tools/audit-report.mjs` 通用遍历）（m00385） |
| 自保护在开发期能否只记录 | **允许 `observe`（仅 `version: 2`）**，仍拒绝 `off` / `allow` | 开发期自保护会拦我们自己的手脚；observe 恰好能留"本来会弹几次卡"的样本。这不是发布档位，1.5.0 收口前要改回 `ask`（m01689、m02113） |
| quiet 的配置放哪 | **`rules.quiet`**，`rules.destructive.workspaceQuiet` 作为兼容别名（`lib/policy/merge.js` 的 `applyAliases()` 在任何人读之前搬过去），两处同时出现由 `quiet-duplicate` 拒绝 | 它决定"要不要弹卡"，不是 destructive 匹配器的属性，当初只是 P1.7 先写在那里。挪位置必须保留旧键，否则升级即静默失效；保留别名又必须拒绝重复，否则改哪份生效靠猜（m03546、m03568） |

---

## 11. 未验证项（不写“应该没问题”）

1. `apply_patch` 的真实参数形状——宿主 checkout `%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\app.asar\dsh\` 在本机不存在（路径无效），读不到定义。**2026-11-16 更新**：自保护侧已用"扫描所有字符串参数里的 `*** File:` 行"绕开这个未知（§7.1 第 2 条）；仍未验证的是宿主到底把补丁放在哪个键、以及 R1home 的 `gap-apply-patch-delete-dsh` 是否要同法修补。
2. observe 场景返回 `next()` 是否与 allow 完全等价——按 `tools/pre-execute` 契约推断，未 live 验证。**2026-11-17 更新**：mount 级测试已确认 `decision.kind === 'allow'` 且审计只有 `observed` 一条（不是 `allowed`），但宿主真实放行流程仍未 live 走一遍。
6. **observe × R3 脱敏的宿主 live 验证**（2026-11-17 新增）——**同日已验**：临时把 `~/.dsh/guardrails/policy.json` 的 `rules.secrets.mode` 改成 `observe`，跑 `Write-Output "sk-…"`：无卡、无拦截，审计一条 `event:"observed"`、`rule:"R3"`、`mode:"observe"`、`redacted:["openai"]`、`payloadBytes:32`；落盘 payload 正文是 `Write-Output "<redacted:openai>"`，sha256 与记录一致，全审计目录搜 token 0 次。再给 `patterns` 加一条命中占位符的 `redacted` 后重跑：`payloadRef`/`payloadSha256` 均 `null`、`payloadBytes` 是原文长度、`redacted` 仍列标签（失败关闭生效）。验完已把 `mode` 改回 `ask`、`patterns` 清空，并确认同一条命令重新变成 R3 deny（`payloadSha256:null`、token 0 次）。
3. ~~自保护在 junction/软链加载下的真实路径~~ —— **2026-11-16 已验**：profile 里 `@vlad/dsh-guardrails` 是指向工作区的 junction，`realpathSync` 解析出 `D:\work\guardrails\dsh-guardrails`，`assertSelfRoot` 通过。
4. ~~`dsh-guardrails/index.js:334` 的 `roots` 合并后对 `facts.protectedHit` 的实际文案~~ —— **2026-11-16 已验**：`test/self-protect.test.mjs` 断言合并 roots 后 `facts.protectedHit === true` 且卡片含 `受保护目录` / `protected directory`。
5. ~~`write`/`edit`/`apply_patch` 的审批卡片是否预览参数正文~~ —— **2026-11-16 已验**：`write` 弹卡、卡片不含正文（用户确认），`describe()` 只给 label（§2.6-1）。残余：用户反馈卡片上没见到路径与提示，待确认是否渲染 bug。

---

## 12. 与既有文档的同步点

| 文档 | 要改什么 | 状态（2026-11-17） |
|---|---|---|
| `design/p2-audit-v2.md` §4.1 | 事件表加 `observed`；公共字段补 `reasons/secretHit/policyVersion/entryId/reasonsTruncated/redacted` | 已改（第 3 步） |
| `design/p3-handoff.md` §0 | 版本、基线提交、tag、测试条数快照 | 已改（收口：1.5.0 / `82cdcd7` / 17 文件 400 条） |
| `design/p3-handoff.md` §6 | 指向本文 | 已改（标注“本文已过期”并指向 §7.6） |
| `D:\work\DSH-guardrails-DOCS\implementation-plan.md` §6 | 勾选条目、把本文列进产出 | **未做**：仓库外文档，需要用户确认后再改（改它同样是一次 R1 写入） |
| `dsh-guardrails/docs/` 威胁模型 | 非沙箱、已知绕过、`policy.json` 是受信输入 | 已并入三处，**不单建文件**：`README.md` 的 Limits、`docs/DSH-API.md` 的“宿主不给插件做的事”、`docs/POLICY.md` 的“需要知道的边界”。单建一份只会多一个会漂移的副本 |
