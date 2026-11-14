# DSH 护栏改造实施计划

> 状态：方案定稿，尚未动工。本文是唯一事实来源，阶段完成或决策变更时同步更新。
> 范围：本仓库内的 `dsh-guardrails/` 插件本体。
> 不在范围内：DSH 宿主源码、`scripts/` 下的个人运维脚本（另议）。

---

## 0. 已定决策（不再讨论，除非明确推翻）

| 编号 | 决策 | 影响 |
|---|---|---|
| D1 | 许可证用 **MIT** | 允许任何人修改再分发，只需保留版权声明 |
| D2 | **Windows-only**，不做跨平台 | 路径层继续用反斜杠 + 小写比较，POSIX 不承诺 |
| D3 | 文案**按界面语言二选一**，英文副本单独存放（日志/`reason`） | 卡片只显示一种语言，文本量省一半 |
| D4 | 客户端偏好为 `en` 时，决策文案必须显示英文 | 由 DSH 原生 `LocalizedText` 解析保证，非额外分支 |
| D5 | 第一阶段**只改宿主侧**，不做客户端插件卡片 | 不改 UI 结构、不加构建链 |
| D6 | 审批卡片**只用一个标题字符串**承载信息 | 受宿主渲染限制，见 §1 |

---

## 1. 基线事实（动手前必须知道，均已核实）

| 事实 | 依据 | 对我们的约束 |
|---|---|---|
| `LocalizedText = string \| { en: string; [locale]: string }`，**`en` 必填** | DSH 类型声明 | 每套文案必须有完整英文，天然满足 D3/D4 |
| `resolveText`：字符串原样返回；map 按 `fallbackChain(active)` 取值、`en` 兜底 | DSH 客户端实现 | 切换语言零代码；未知语言回退英文 |
| 内置语言 id 只有 `zh`、`en` | `LOCALE_IDS` | 不要用 `zh-CN` 作 key |
| 审批卡片结构：顶部条（固定“等待审批”）/ 标题 / 说明（工具审批不传）/ 命令区（自动取 `args.command`）/ 按钮“拒绝”“允许一次” | 客户端 `ApprovalPanel` + `ApprovalCard` | **插件只能控制标题**；命令区只读、按钮固定 |
| 标题 CSS：15px / 行高 24px，**无 `white-space: pre-wrap`** | 卡片样式表 | `\n` 会被折叠成空格，只能靠分隔符分行 |
| 卡片正文 `max-height: 336px`，超出滚动 | 卡片样式表 | 标题建议 ≤5 行，长文案会出滚动条 |
| 审计现状：`rule/mode/tool/decision/target`，`target` 截断 120 字符，`decision` 基本只有 `asked` | 现有 `index.js` + 审计文件 | 事后无法复盘，P2 必须重做 |
| 心跳 `loaded.json` 在挂载与被拦截时写入，版本**硬编码** `1.1.0` | 现有 `index.js` | 改版本要改两处；P0 修 |
| R1 只保护 `~/.dsh` 与 `~/.agents` | `policy.json` | 插件源码在 `D:\...\guardrails`，**不受保护**（P3 处理） |

---

## 2. 总体路线

```
P0 开工前置（不改代码）
 └─ P1 弹窗可读性：事实摘要 + 文案外置
     └─ P2 审计 v2：决策可追溯 + 完整性
         └─ P3 可修改性：策略表达 + 自保护 + 契约测试
             └─ P4 开源发布：许可证 / 元数据 / 文档 / CI
```

| 阶段 | 目标 | 规模 | 主要产出 |
|---|---|---|---|
| P0 | 可安全动手 | S | 备份 + 基线 + 心跳核验 |
| P1 | 弹窗一句话讲清“做什么、动哪里、多大规模、能否撤销” | M | `lib/facts.js`、`lib/describe.js`、`i18n/` |
| P1.6 | Windows 系统级操作硬停（磁盘/启动/系统目录/配置单元） | S | 见 [p1.6-windows-critical.md](p1.6-windows-critical.md)；S1 已实现，S3 live 验收待重启 |
| P2 | 每次敏感操作可复盘 | M | 审计 v2 + 哈希链 + 查询命令 |
| P3 | 别人能改、绕过成本变高 | M | 策略 v2、`check` CLI、自保护、契约测试 |
| P4 | 可分享 | S | MIT LICENSE、README、CI |

**每个阶段独立可交付、可回滚。上一阶段验收不通过，不进入下一阶段。**

---

## 3. P0 — 开工前置

目标：在动任何代码之前，确保“护栏是活的、有退路、有基线”。

### 步骤

- [ ] 核对 `~/.dsh/guardrails/loaded.json`：版本与 `package.json` 一致、mtime 在最近几分钟内
- [ ] 备份到当前工作区 `_backup/<yyyyMMdd-HHmmss>/`：`dsh-guardrails/`、`scripts/`、`README.md`
- [ ] 记录基线：`index.js`、`rules.js` 的 sha256，`policy.json` 内容，当日审计行数
- [ ] 跑一遍现成测试：`node test/rules.test.mjs`、`node test/plugin.smoke.mjs`（预期 14 + 5 全绿）
- [ ] 在 `_backup` 里写一份 `manifest.md`：改了哪些文件、怎么还原

### 验收

- 心跳新鲜、19 条测试全绿、备份目录可读。
- 任一条不满足就停下，先修环境。

### 回滚

把 `_backup/<ts>/` 的内容覆盖回原路径，重启 DSH。

---

## 4. P1 — 审批弹窗可读性（先做这个）

目标：标题从“规则术语”变成“可决策的事实”。

### 4.1 目标形态

**改前（典型 R2）**

```
红线 R2：破坏性操作（Remove-Item）。批准前请要求先给出「将改动哪些文件」的完整清单。
```

**改后（中文界面，约 3–4 行，靠分隔符分行）**

```
⚠ 删除目录（递归）｜D:\work\dist｜42 个文件｜不可恢复
```

**英文界面同一份数据（`en` 键）**

```
Delete directory (recursive) at D:\work\dist — 42 files, irreversible
```

英文副本同时写入审计（P2），满足“可查”。

### 4.2 事实模型（`facts`）

语言中立、只写证明得了的东西：

| 字段 | 含义 | 来源 | 拿不到时 |
|---|---|---|---|
| `kind` | `delete` / `move` / `overwrite` / `create` / `registry` / `service` / `plugin` / `secret` | 工具名 + 命令动词 | `unknown` |
| `target` | 规范化的绝对路径 | `expandPath` | 省略该段 |
| `exists` / `isDir` | 目标是否已存在、是否目录 | 一次 `stat`（失败即忽略） | 不写 |
| `count` | 文件数量 | 有界枚举（上限 500，超出写 `500+`） | 不写 |
| `recursive` | 是否递归/强制 | `-Recurse`、`/MIR`、`-Force` | 不写 |
| `reversible` | `true` / `false` / `unknown` | 动作类型推定（删除/覆写=否，移动=是） | `unknown` |
| `protectedHit` | 是否命中受保护根 | `isUnder` | 不写 |
| `secretLabel` | 密钥类型 | 现有 `SECRET_LABELS` | — |

**硬规则：证不出来就不写，绝不猜。** 事实计算失败不影响拦截（fail-open 维持现状）。

### 4.3 文案组织

```
i18n/zh.json     i18n/en.json     ← 两个文件，key 集合与占位符必须一致
        └────────────┬─────────────┘
                     ▼
            lib/describe.js：facts + locale 资源 → { en, zh }
                     ▼
   rules.js 的 displayReason 由 describe() 生成（不再手写句子）
```

- key 命名：`<rule>.<kind>.<片段>`，例如 `R2.delete.headline`、`common.irreversible`、`common.unknownScope`。
- `en` 永远写全，作为 `LocalizedText` 的必填项。
- 加新语言 = 加一个 JSON + 一条 parity 测试，不改代码。

### 4.4 标题写作规范

1. 结论先行：动词开头，不出现“红线 R2”这种代号开头（编号放末尾或省略）。
2. 顺序固定：`动作 → 目标 → 规模 → 可逆性`，各段用 `｜` 分隔。
3. 单语种，不中英混排（混排交给 P2 日志）。
4. 中文 ≤ 100 字符 / 英文 ≤ 120 字符，超出优先砍“规模”，保留“可逆性”。
5. 不用 markdown、不加颜色（宿主不支持）。

### 4.5 拒绝文案

`deny` 路径返回的 `reason` 增加指令性后缀，降低“换个写法再撞”的概率：

```
不执行该操作。不要原样重试；如需继续，先给出 dry-run 清单或改用更小范围的命令。
```

### 4.6 改动清单（预计）

| 文件 | 动作 |
|---|---|
| `i18n/zh.json`、`i18n/en.json` | 新增 |
| `lib/facts.js` | 新增（纯函数，可单测） |
| `lib/describe.js` | 新增（纯函数） |
| `rules.js` | 改：`displayReason` 改为调用 `describe()`；规则判定逻辑不动 |
| `index.js` | 改：心跳版本改读 `package.json`；其余协议不动 |
| `test/rules.test.mjs` | 加 4 条快照（R1 覆写、R2 删除、R3 密钥、未知动作） |
| `test/i18n.test.mjs` | 新增：zh/en key 与占位符 parity |

### 4.7 验收

- [ ] 单测全绿（原 19 + 新增 ≥5）
- [ ] 中英切换：界面语言改 `en` 后，同一操作显示英文文案
- [ ] R3 用例：标题不出现密钥原文，只出现类型标签
- [ ] 真实弹窗（拒绝式探针）：发起一次写入 `~/.dsh/` 临时文件的操作 → 弹窗可读 → 点“拒绝” → 不产生任何文件
- [ ] 重启后 `loaded.json` 版本与 `package.json` 一致、mtime 刷新

### 4.8 未验证项（P1 内顺手确认）

- [ ] 标题里塞 `U+2028` 能否强制换行（不成功就只用分隔符）
- [ ] `tools/pre-execute` 的 `exec` 是否带 `callId`（决定标题能否带审计编号）

### 4.9 回滚

整体覆盖回 P0 备份，重启 DSH。

---

## 5. P2 — 审计 v2

目标：一次操作产生两条事件，事后能回答“问了什么、结果如何、依据是什么”。

### 5.1 事件模型

```json
{"v":2,"id":"apr-3f7a","event":"ask","ts":"2026-11-14T06:00:00.000Z",
 "sessionId":"...","cwd":"...","tool":"pwsh","toolCallId":"...",
 "rule":"R2","severity":"high","allowedDecisions":["approve","reject"],
 "facts":{"kind":"delete","target":"D:\\work\\dist","count":42,"reversible":false},
 "displayReason":{"en":"...","zh":"..."},"localeAtDecision":"zh",
 "previewHash":"sha256:...","prevHash":"sha256:...","hash":"sha256:..."}

{"v":2,"id":"apr-3f7a","event":"outcome","ts":"...","decision":"rejected",
 "decidedBy":"user","latencyMs":8300,"hash":"..."}
```

### 5.2 关键设计点

- **全文不截断**：`facts` 存结构化事实；长命令原文进 `payload/<日期>/<id>.txt`，日志只存路径 + hash。
- **R3 例外**：命中密钥时只存类型标签 + hash，原文**绝不落盘**。
- **完整性**：`hash = sha256(prevHash + 规范化 JSON)`，链尾写入 `index.json`；查询命令提供 `--verify`。
- **脱敏策略词表**：`redact` / `mask` / `hash` / `block`（对齐主流实现，便于以后扩展）。
- **写入失败不阻断**：stderr + `audit/.write-errors.log` + 弹窗提示“本次未写入审计”。

### 5.3 前置验证（先做，决定方案）

- [ ] DSH 是否暴露“审批结果”事件。若无，则用 `tools/post-execute` / `tools/result` 推断“执行了/没执行”，并把 `decision` 记为 `executed` / `not_executed` 而非 `approved` / `rejected`。
- [ ] `exec` 是否带 `callId`，用于与卡片关联。

### 5.4 验收

- [ ] 一次“拒绝”和一次“允许”各产生 2 条事件，且能用 `id` 关联
- [ ] `--verify` 能发现被手工删除的中间行
- [ ] R3 用例全量扫描日志，确认无密钥原文
- [ ] 旧 `audit-*.jsonl` 不被改写，查询命令兼容 v1

---

## 6. P3 — 可修改性与自保护

目标：别人能安全地改；绕过护栏的成本变高。

### 6.1 策略 v2（向后兼容 v1）

| 新能力 | 说明 | 来源 |
|---|---|---|
| `mode: "observe"` | 只记不拦，用于上线前量化误报 | Prismor |
| 显式优先级 `block > review > allow` | 多规则命中时结果确定，不依赖代码顺序 | agent-policy-firewall |
| `reasons[]` | 审计记录全部命中原因，而非只记一条规则 | agent-policy-firewall |
| 按工具 + 条件（`when`） | 粗粒度“某工具一律问”与细粒度路径规则共存 | LangChain HITL |

### 6.2 自保护

现状缺口：插件源码在 `D:\...\guardrails\dsh-guardrails`，不在 R1 保护范围内，agent 可直接改写 `rules.js`，重启即生效。

- [ ] 新增受保护根（默认指向插件源码目录），任何写入/改名/删除都触发审批
- [ ] 守卫 `policy.json` 与 `i18n/`：允许读，改必须审批
- [ ] 文档写明：这不是沙箱，用户有本机权限时仍可直接改文件

### 6.3 CLI 与契约测试

- [ ] `check` 子命令：`dsh-guardrails check --tool pwsh --args '{...}'`，退出码 `0` 放行 / `2` 需审批 / `3` 拒绝
- [ ] 表驱动契约测试：覆盖全部默认规则 + 已知绕过样例（变量拼接、`cmd /c`、`powershell -enc`）
- [ ] `policy.schema.json` + 启动时校验，坏文件回退上一份并记日志

### 6.4 验收

- [ ] 故意写 `rules.js` → 触发审批而不是静默成功
- [ ] `observe` 模式下操作不被拦，但审计有完整记录
- [ ] CLI 退出码在 CI 中可用

---

## 7. P4 — 开源发布

目标：外人能在一小时内跑起来并改成自己的规则；**不承诺跨平台**。

### 7.1 仓库整理

- [ ] `LICENSE`（MIT，版权行写你）
- [ ] `README.md`：定位（宿主原生最小门禁）、安装、五条示例规则、威胁模型、Windows-only 声明
- [ ] `SECURITY.md`：漏洞报告方式、支持版本
- [ ] `CONTRIBUTING.md`：怎么加规则/加语言、测试怎么跑、代码注释用英文
- [ ] `CHANGELOG.md`：从 1.1.0 起
- [ ] `.gitignore`：`_backup/`、`audit/`、`vault/`、`node_modules/`、`*.log`

### 7.2 去个人化

- [ ] README 里 `~/.dsh/profiles/desktop/...` 改成通用路径
- [ ] `scripts/` 不进包（个人运维脚本，依赖本机布局）
- [ ] `policy.json` 只给示例，不带真实根目录
- [ ] 代码注释英文化（符合 `constraint.weak.local`，也降低外部贡献门槛）

### 7.3 包元数据

- [ ] 包名去掉 `@local/`（或换成你的 scope）
- [ ] `license: "MIT"`、`repository`、`engines.dsh`（声明兼容区间）、`files` 白名单
- [ ] 版本规则：`1.x` 内保持协议兼容；破坏性变更升 `2.0`

### 7.4 CI

- [ ] `windows-latest` + Node 24：跑两个测试文件
- [ ] i18n parity 检查
- [ ] `check` CLI 冒烟用例

---

## 8. 每阶段通用纪律

1. **R1**：动插件前先备份到 `_backup/<时间戳>/`，先给清单和 diff，再落盘。
2. **一次一类改动**：文案改动不夹带逻辑改动，逻辑改动不夹带格式化。
3. **改完必重启**：宿主插件不热重载；重启后核对 `loaded.json` 的版本与 mtime。
4. **失败要响**：任何“静默跳过”的分支（审计写失败、策略解析失败、文案缺失）都必须留下可见痕迹。
5. **文案缺失不崩**：`en` 缺失时回退到硬编码兜底句，并在日志里记一条 `i18n-missing`。

---

## 9. 风险登记

| 风险 | 影响 | 缓解 |
|---|---|---|
| 改完重启后插件静默不加载 | 以为有护栏其实没有 | P0/P1 验收固定包含 `loaded.json` 核对；health-check 必跑 |
| 标题太长导致滚动 | 可读性反而下降 | 单语 ≤100/120 字符；超限砍“规模”段 |
| `en` 与 `zh` 语义漂移 | 日志归档不等价 | parity 测试 + 一次人工评审 |
| 事实计算引入延迟 | 每次工具调用变慢 | `stat` 一次、枚举上限 500、总预算 50ms，超时降级 |
| 正则被变形绕过 | 误以为安全 | 文档写明“非沙箱”；P3 加绕过样例做回归测试 |
| 审计含敏感信息 | 隐私风险 | R3 只落 hash；默认脱敏；文档写明日志内容 |
| 自保护规则误伤自己 | 插件更新被拦 | 自保护只拦工具调用，不拦插件自身文件写入（进程内写不受 tools 钩子约束） |

---

## 10. 不做什么（明确的非目标）

- ❌ 客户端插件卡片（除非 P1 效果明确不足，再单独立项）
- ❌ 跨平台（Linux/macOS）
- ❌ LLM 语义判定（热路径延迟不可接受，且不信任模型自评）
- ❌ 沙箱 / 网络隔离 / 供应链防护（与 Prismor 那类产品不竞争）
- ❌ 持久化审批（跨重启恢复）——宿主职责
- ❌ 批量审批、编辑参数后执行（DSH 卡片无此按钮）

---

## 11. 附录 A：文案预算

| 语言 | 标题上限 | 说明 |
|---|---|---|
| 中文 | 100 字符（≈4 行 @ 24px） | 超过优先删“规模”，保留“不可逆” |
| 英文 | 120 字符（≈4 行） | 同样规则 |

三段式示例：

```
⚠ 覆写文件｜C:\Users\...\.dsh\AGENTS.md（已存在）｜不可恢复
⚠ 删除目录（递归）｜D:\work\dist｜42 个文件｜不可恢复
⚠ 参数含密钥（Ark API Key）｜写入会话日志后无法撤回
```

## 12. 附录 B：决策词表（与审计、CLI 对齐）

| 内部值 | 含义 | 卡片按钮 | 审计 decision |
|---|---|---|---|
| `approve` | 允许一次 | 允许一次 | `approved` / `executed` |
| `reject` | 拒绝并给指令 | 拒绝 | `rejected` / `not_executed` |
| `observe` | 只记录不拦 | — | `observed` |
| `deny` | 规则直接拒绝（不弹窗） | — | `denied` |

保留 `edit`、`respond` 作为未来值，当前不实现。
