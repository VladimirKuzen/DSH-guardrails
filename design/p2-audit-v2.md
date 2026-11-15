# P2 审计 v2 设计

- 状态：v1.0（第一批已实现，2026-11-15，对应 1.3.0；live 复测见下）
- 目标版本：1.3.0（第一批）、1.4.0（第二批，工作区静默）
- 读者：维护者本人（本文件用中文写，便于反复阅读）

## 0. 实现状态（2026-11-15）

- 第一批已在 1.3.0 落地：`dsh-guardrails/lib/audit/v2.js`（事件流、payload、哈希链、`verifyChain`）、
  `index.js` 的 `requested / delivered / outcome / executed` 接线、`tools/audit-report.mjs`、
  `test/audit.test.mjs`（9 条）与 `test/plugin.smoke.mjs` 的 v2 断言。
- 离线验证已完成：`--stats`、`--verify`、`--show-payload` 在夹具上通过；102 条测试全绿。
- 待 live 验证：根上下文能否收到 `session/event`（若收不到，改为 `ctx.on('session/event', fn, { global: true })`，
  已在代码注释里标明）。验证方法：重启后触发一次 R2 ask，用 `audit-report.mjs` 看是否出现 `delivered`。
- 未做：1.4.0 的 `workspaceQuiet`（P1.7），按计划在第二批。
- 1.3.1 修复：首次 live 运行（15:17Z 的删卡探针）四条事件都写对了，但 `--verify` 报哈希不符——
  `canonicalJson` 与 `JSON.stringify` 对 `undefined` 的处理不一致，`facts.severity` 为空时写盘被丢弃、
  哈希里却留下了。已统一语义并补回归测试；1.3.0 写下的记录需要轮换。

## 1. 要解决的问题

v1 审计只有一个 `asked` 动作和一行被截断的 `target`，它回答不了四个问题：

1. 用户到底有没有看到这张卡？（现在 `asked` 在宿主送达之前就写了，参数校验失败也会留下幽灵记录）
2. 用户点了什么？允许一次、拒绝、取消，还是根本没有审批通道？
3. 批准之后，工具到底执行了没有、成功没有？
4. 当时卡片上写的是什么？同一段命令，换一种语言界面，用户看到的文案不一样，事后却对不上。

v2 的目标一句话：**每条被护栏介入的敏感操作，都能从磁盘上还原出"当时发生了什么"。**

## 2. 非目标

- 不做签名、不做 Ed25519（留给 P3 或更后）。
- 不做跨机器聚合、不做界面，只在磁盘上留可读可校验的事件流。
- 不改 DSH 自身的会话日志与审批日志。

## 3. API 验证结果（只读验证，已核对宿主源码）

| # | 结论 | 证据 |
|---|------|------|
| 1 | 审批审计事件是**会话事件**，追加到日志后通过 `session/event` 广播（post-commit、fire-and-forget、观察者异常被包含） | `dsh-session/src/index.ts:79` 定义 `'session/event'`；`docs/subsystems/session.zh.md:1412-1430` |
| 2 | `approval/asked` 载荷：`{ id, toolName, callId?, reason? }` | `dsh-user-approval/src/types.ts:44-58` |
| 3 | `approval/decided` 载荷：`{ id, outcome }`，outcome 为 `allowed-once｜rejected｜cancelled｜unavailable` | `dsh-user-approval/src/types.ts:55-58`；`types.ts:32` |
| 4 | `request()` 的顺序是：先 append `approval/asked`，再取结果，最后 append `approval/decided` | `dsh-user-approval/src/index.ts:251-260` |
| 5 | 工具流水线把 `callId`、`reason`、`displayReason` 一起传给 `approval.request` | `dsh-tools/src/pipeline.ts:457-464` |
| 6 | outcome 到执行的映射：`allowed-once` 放行；其余三种转成 `ApprovalError`，code 分别为 `APPROVAL_REJECTED／APPROVAL_CANCELLED／APPROVAL_UNAVAILABLE` | `dsh-tools/src/pipeline.ts:465-480` |
| 7 | 被拒绝的调用**仍会**走 `tools/post-execute`（denial 以 `post-result` 形式返回），只有构造失败/取消等才走 `final-result` 跳过 post | `dsh-tools/src/pipeline.ts:204-233`、`343-371` |
| 8 | `tools/result` 对每次调用都会触发（含拒绝与工具报错） | `dsh-tools/src/pipeline.ts:406-426` |
| 9 | `displayReason` **不会**写进审批审计（注释明确 "never persisted"），所以卡片文案必须由护栏自己落盘 | `dsh-user-approval/src/types.ts:72-73` |
| 10 | `approval.request()` 要求会话处于未结束的轮次内，否则直接抛错、不产生任何事件 | `dsh-user-approval/src/index.ts:244-250` |
| 11 | 插件可以监听 `session/event`：仓库内 62 处一等方插件这样用（如 `dsh-goal/src/index.ts:261`、`dsh-session-telemetry/src/coordinator.ts:104`、`dsh-session-persistence-jsonl/src/storage.ts:549`） | 见上述路径 |
| 12 | `Session` 暴露 `id` 与可选 `cwd` | `dsh-session/src/types.ts:102,106` |

结论：**v2 不需要宿主新增任何 API**，用 `session/event` 监听 + 我们自己的 `tools/pre-execute`、`tools/post-execute` 就能闭环。

两个必须写进实现的细节：

- `approval/asked` 在 `decide()` **之前**追加，所以 `delivered` 的语义是"请求已进入审批服务/应答者链"，**不是**"卡片已经渲染到用户屏幕上"。
- `session/event` 在插件根上下文能不能收到所有会话还需要 live 复核；如果收不到，监听时要带 `{ global: true }`（`dsh-api-session-controller/src/state/listener.ts:42` 这样用）。

## 4. 事件模型

v2 用追加式事件流，一条操作可能产生多条记录，同一 `id` 贯穿。

### 4.1 五个事件

| 事件 | 何时写 | 作用 |
|------|--------|------|
| `requested` | 护栏判定为 `ask`、返回 `ask` **之前** | 证明"护栏要求了审批"，含完整上下文 |
| `delivered` | 观察到 `approval/asked` 且 `callId` 命中我们的 pending 表 | 证明"请求真的进了审批链" |
| `outcome` | 观察到 `approval/decided`；或护栏直接 deny 时同步写 | 用户决定 / 护栏拒绝 |
| `executed` | `tools/post-execute` 完成且结果为允许执行 | 证明"批准之后确实执行了、成功没有" |
| `allowed` | 仅 P1.7 工作区静默命中时 | 被静音放行的操作也要可查 |

普通 `allow`（不弹卡、不静默）不写任何记录，避免把日志变成全量命令流水。

### 4.2 时序

```
model 发起工具调用
  ├─ tools/pre-execute（护栏）
  │    ├─ deny  → 写 requested + outcome(source=guardrail) → 返回 deny
  │    └─ ask   → 写 requested(delivered=false) → 返回 ask
  │                └─ 宿主 approval.request()
  │                     ├─ append approval/asked  → 监听器写 delivered
  │                     ├─ 用户决定
  │                     └─ append approval/decided → 监听器写 outcome
  │                          └─ allowed-once → 执行 → tools/post-execute → 写 executed
  └─ 结束
```

### 4.3 字段

公共字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `v` | `2` | 版本 |
| `id` | string | 本次操作的事件流 id（`crypto.randomUUID()`） |
| `event` | enum | 五类之一 |
| `ts` | ISO-8601（UTC，毫秒） | 写入时间 |
| `sessionId` | string | 会话 id |
| `cwd` | string \| null | 会话工作目录；取不到时为空 |
| `cwdSource` | `session｜tool｜null` | `cwd` 的来源：会话本身、shell 工具的 `workdir` 参数、或未取到 |
| `tool` | string | 工具名（`pwsh`、`write` 等） |
| `callId` | string \| null | 工具调用 id，用于把审批事件串回来 |
| `rule` | `R1｜R2｜R3` | 命中规则 |
| `severity` | `critical` \| 省略 | 系统级硬停时存在 |
| `mode` | `ask｜deny｜allow` | 处置 |
| `target` | string | 展示用目标，按**码点**截断 300，控制字符转义 |
| `facts` | object | 结构化事实：`kind/action/reversible/count/paths/secretLabel/quiet` 等 |
| `displayReason` | `{en,zh,...}` | 当时卡片文案的完整 map |
| `localeAtDecision` | `zh｜en` | 当时界面语言 |
| `payloadRef` | string \| null | 原文文件相对路径 |
| `payloadSha256` | string \| null | 原文哈希 |
| `payloadBytes` | number \| null | 原文字节数 |
| `payloadTruncated` | bool | 是否只存了前缀 |
| `prevHash` | string | 上一条的 `hash`，当天首条为 `chain.json` 的 `lastHash` 或 `"genesis"` |
| `hash` | string | 本记录的链哈希 |

各事件额外字段：

- `requested`：`delivered: false`
- `delivered`：`approvalRequestId`、`deliveredAt`
- `outcome`：`outcome`（四种之一）、`source`（`user｜guardrail`）、`approvalRequestId`（护栏拒绝时省略）
- `executed`：`isError`、`errorCode`、`durationMs`

`cwd` 的回退顺序是 `session.cwd` → shell 工具的 `workdir` 参数 → 空。**刻意不取 `process.cwd()`**：
那是宿主进程的启动目录（通常是安装目录），写进"当时在哪个目录"会被当成工作区误读；宁可留空。
- `allowed`：`quiet: "workspace"`

## 5. 文件布局

```
~/.dsh/guardrails/
  audit/
    v2/
      2026-11-15.jsonl              # 一天一个事件流
      payload/2026-11-15/<id>.txt   # 原文，按事件 id 命名
      chain.json                    # { date, lastHash, count }
    audit-2026-11-15.jsonl          # v1 旧文件，只读保留
```

写入顺序：先写 payload（如需要），再写 jsonl 记录；payload 写失败时记录 `payloadRef: null` 并附 `payloadError`，不阻断主流程。

## 6. 原文落盘规则

- shell 命令：整段原文（含换行）。
- 文件写入：原文可能很大，最多存前 64 KiB，同时记录 `payloadSha256` 与 `payloadBytes`，超出时 `payloadTruncated: true`。
- **R3 永不落原文**：只写 `secretLabel`、原文的 sha256、以及脱敏后的 `target`，保证"密钥值不进入任何文件"。
- 保留期：默认 30 天，由报告脚本 `--purge` 手动清理，不在写入路径自动删。

## 7. 哈希链

```
hash = sha256(prevHash + "\n" + canonicalJson(recordWithoutPrevHashAndHash))
```

- `canonicalJson`：键名排序、UTF-8、无多余空白、数字按 JSON 规则输出。
- 每天首条的 `prevHash` 取 `chain.json.lastHash`，没有则 `"genesis"`。
- 每条写完后原子更新 `chain.json`（临时文件 + rename），崩溃时最多丢最后一条的链头。

## 8. 并发、顺序与崩溃

- 单进程写入，用一个 promise 队列串行化；底层 `appendFileSync`。
- 崩溃可能留下半行：读取时若最后一行没有换行结尾，视为不完整尾行，丢弃并标记 `tail-truncated`。
- 进程内 pending 表：`callId → { stash, requestedId }`；插件卸载时清空。未走到 `delivered` 的 `requested` 由报告脚本标为 `pending`（这是诚实的"没送达"，不再是幽灵）。
- 顺序保证：`requested` 在返回 `ask` 之前同步写完，所以它一定早于 `approval/asked`。

## 9. 隐私与安全

- 审计目录依赖用户 profile 的 ACL；插件不额外放宽权限。
- R3 记录只有标签与哈希，不含密钥值与原文。
- 报告脚本默认不打印 payload 内容，需 `--show-payload` 显式打开。

## 10. 与 P1.7 工作区静默的接口

- 静默命中时**不写** `requested`，直接写一条 `allowed`：`{ mode: "allow", quiet: "workspace", facts, target }`。
- 这样"被静音而放行的操作"依然留痕，且与弹卡记录能区分开。
- 静默开关关闭时，行为与今天一致：不写任何 allow。

## 11. 迁移与兼容

- 新代码只写 v2；v1 文件原样保留，不改写、不删除。
- 报告脚本默认合并读 v1+v2：
  - v1 的 `decision: "asked"` 映射成"不确定是否送达"的 `requested`；
  - v1 的 `decision: "denied"` 映射成 `outcome(source=guardrail)`。
- 提供 `--legacy-only` 与 `--v2-only`。
- 按用户决定：P2 阶段脚本带适配，全部完成之后可以移除或注释掉这段兼容代码。

## 12. 查询与报告脚本

仓库内新增 `dsh-guardrails/tools/audit-report.mjs`（不进 `files` 白名单，不随包发布）：

```
node tools/audit-report.mjs --since 7d --rule R2 --event outcome
node tools/audit-report.mjs --verify          # 校验哈希链
node tools/audit-report.mjs --stats           # 允许/拒绝/执行比例
node tools/audit-report.mjs --show-payload <id>
```

输出列：时间、规则、severity、目标、displayReason（当前语言）、outcome、executed、payload 路径。

## 13. 失败模式与降级

| 场景 | 行为 |
|------|------|
| 审计目录不可写 | `ctx.logger.warn` 后继续，不阻塞工具执行（保持现有 fail-open 取舍） |
| payload 写失败 | 记录 `payloadRef: null` + `payloadError`，仍写 `target` |
| `chain.json` 损坏 | 用最后一个可解析的 `lastHash` 续写，并写一条 warn 日志 |
| 半行残留 | 读取时忽略尾部不完整行；写入前先补换行 |
| 时钟回拨 | `ts` 只作展示，不参与链校验 |
| 会话事件收不到 | 降级为只有 `requested`，报告标 `pending`；不影响拦截行为 |

## 14. 验收矩阵

1. ask → 允许一次 → 执行成功：`requested/delivered/outcome(allowed-once)/executed(isError=false)`，payload 原文可读。
2. ask → 拒绝：`outcome(rejected)`，无 `executed`。
3. 应答者缺失：`outcome(unavailable)`。
4. 无 agent 或审批 seam 缺失：只有 `requested`，无 `delivered/outcome`，报告标 `pending`。
5. R3 shell deny：`requested + outcome(denied, source=guardrail)`，无 payload，target 不含密钥。
6. critical deny：同 5，带 `severity: "critical"`。
7. P1.7 静默 allow：只有 `allowed(quiet=workspace)`，无卡片。
8. 崩溃模拟：截断最后一行后 `--verify` 报 `tail-truncated`，不误判前面的记录。
9. 并发 20 个 ask：链连续、无记录丢失。
10. 跨天：次日首条 `prevHash` 接上前一天 `lastHash`。
11. 中文/emoji 目标：按码点截断，无 `鈥?` 类乱码。
12. `displayReason` 与当时界面语言一致，事后可复原。

## 15. 分批交付

- **1.3.0（P2 第一批）**：v2 写入器（requested/delivered/outcome/executed）、payload、哈希链、报告脚本 `--verify`；配置 `audit.format` 默认改 `v2`，可回退 `v1`。
- **1.4.0（P2 第二批）**：`workspaceQuiet` + `allowed` 事件。
- **之后**：移除 v1 适配、P3 签名。

## 16. 已定与待决

已定：

- 事件命名：`requested / delivered / outcome`（前者）。
- 原文必须落盘（R3 除外）。
- 本文件提交进仓库；此后计划类 `.md` 用中文写。

待决：

- `session/event` 是否需要 `{ global: true }`（live 阶段验证）。
- 报告脚本是否随 1.3.0 一起进 `files` 白名单（当前打算不进）。
- payload 保留期默认 30 天是否合适。
