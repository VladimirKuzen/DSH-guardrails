# 策略怎么写

这个文件决定护栏怎么判。`DETAIL.md` 讲"护栏拦什么"，这一页讲"怎么调"。

## 文件在哪

| 位置 | 什么时候读 |
|---|---|
| `~/.dsh/guardrails/policy.json` | 挂载后一直读这份 |
| `$DSH_GUARDRAILS_POLICY` | 设置后取代上面的路径 |
| 插件条目的 config（profile 里） | 合并到文件值之下 |

优先级是 默认值 → 文件 → 插件条目配置；运行期只会重读文件。

## 改完怎么生效

- 大约两秒内生效，不重启、不重载。
- 解析失败**或**校验失败的文件会被整份忽略，继续用上一份好策略；同时写一条
  `logger.warn` 和一条 `config-invalid` 审计记录（记录里带具体字段，例如
  `rules.quiet.enabled`）。
- 带 BOM 保存没关系，解析前会剥掉。
- 改这个文件本身是对 `~/.dsh` 的写入，所以 R1 会问一次；用 shell 删它同理。
  用编辑器改，改完等两秒即可。

## 结构

```json
{
  "version": 2,
  "enabled": true,
  "auditDir": "~/.dsh/guardrails/audit",
  "audit": { "format": "v2", "maxPayloadBytes": 65536 },
  "rules": {
    "protectDshHome": { "mode": "ask", "roots": ["~/.dsh", "~/.agents"], "alwaysAskTools": ["plugin_manager"] },
    "critical": { "mode": "deny", "patterns": [], "failClosed": true },
    "destructive": { "mode": "ask", "patterns": [], "dryRun": { "enabled": false, "minChars": 400, "minStatements": 3, "dynamicTarget": true } },
    "secrets": { "mode": "ask", "patterns": [] },
    "selfProtect": { "mode": "ask", "paths": [] },
    "quiet": { "enabled": false, "roots": [], "paths": ["_scratch"], "alwaysAsk": [".git", ".", ".."] }
  },
  "entries": []
}
```

`version` 选引擎：`1`（或不写）是原始语义，`2` 才有排序、`observe`、`allow` 与
`entries`。`enabled: false` 是把整个护栏关掉，能用更窄的改法就别用它。

## 五种 mode

| mode | 引擎 | 结果 |
|---|---|---|
| `deny` | v1 | 直接拒绝，模型收到原因，不弹卡 |
| `ask` | v1 | 弹卡，批准后执行一次 |
| `off` | v1 | 这条规则完全不匹配——不弹卡、不记录 |
| `observe` | v2 | 记一条 `observed`，放行，不弹卡 |
| `allow` | v2 | 记一条 `allowed`，放行——但仍可能输给更严的带 |

`critical` 只接受 `deny`、`ask`、`off`。硬停不提供"比 ask 更软"的档位。

## 放宽

没有"按命令豁免"的开关。可用的手段，从最细到最粗：

1. **让 workspace quiet 决定。** `rules.quiet.enabled: true` 并把 `roots` 设成
   工作区，工作区内一次例行删除（单语句、一个能解析的文件、不是目录本身、
   不是 `.git`）可以不弹卡，记 `allowed` + `quiet: "workspace"`；其他照旧问。
2. **调干跑阈值**或关掉它——它只改变"什么时候先别弹卡"，不改变放行什么。
3. **降某一档的 mode。** `observe` 只记不问；`allow` 直接放行（仅 v2）。
   一次改一档，不要用 `enabled: false`。
4. **缩小某一档的视野**——`protectDshHome.roots`、`selfProtect.paths`、
   `quiet.paths`。

如果某一档降成 `observe`/`allow` 而里面本来有该挡的，就用 `entries` 的 `deny`
把危险子集捞回来——`examples/policy/relax-with-guard.json` 就是这种白名单反转。

### 三档灰度

1. **先标注，照旧问。** 档位保持 `ask`，加一条 `entries` 的 `observe`。卡照弹，
   每条记录带 `entryId`，先弄清"多频繁、在哪"。
2. **只记录。** 档位降到 `observe`，再对完全不想看到的子集加 `entries` 的
   `deny`。此时不问了，但都有记录。
3. **真的放宽**（或者修正规则）。确认波段确实该放，再 `allow`；如果发现内置正则
   太宽，改正则并补测试——原因写在 `CHANGELOG.md` 里：模式是代码，不是配置。

`outcome` 是另一半证据：当时问了你，你答了没有。高频+高频批准，多半太宽；
高频+很少批准，多半在干活。

## 收紧

常用 `entries` 的 `deny`：

```json
{
  "id": "no-force-push",
  "tool": ["pwsh", "bash"],
  "mode": "deny",
  "when": { "commandMatches": "^\\s*git\\s+push\\b[^|;]*--force" }
}
```

- `id` 会出现在卡面、审计和 `check` 输出里。
- `mode` 可以是 `deny`、`ask`、`observe`、`allow`。
- `when` 至少给一个条件：`cwdUnder`、`targetUnder`、`commandMatches`，三者是"与"。
  路径条件写绝对路径（可用 `~` / `%VAR%`）。
- `commandMatches` 必须 `^` 开头，只作用于 shell 命令。正则看到的是**整条命令文本**，所以
  `^\s*git\s+push` 不匹配 `cd repo; git push --force`——要命中命令中段，得自己在锚点后放宽
  （例如 `^[\s\S]*`），代价是这条规则不再限制"命令从哪开始"。
- `allow` 条目必须带收窄条件，而且**永远赢不了内置的 `ask`/`deny`**——它的作用是
  把意图写进审计，不是开豁免。

## 干跑

`rules.destructive.dryRun` 决定"普通的（非 critical）破坏性 ask"什么时候第一次
直接拒、不给卡：

| 键 | 含义 |
|---|---|
| `enabled` | 总开关 |
| `dynamicTarget` | 目标无法在卡上点名（变量解析不出来）就拒 |
| `minChars` | 命令文本长于该值时拒（默认 400） |
| `minStatements` | 破坏性语句达到该条数就拒（默认 3） |

拒绝信息会让模型先跑只读清单；**原样**重试才弹卡，卡上会多一行"首次尝试已要求
预演"。它只能把一张读不懂的卡变成两张能读懂的，无法验证清单真的跑了。

## 模板

复制后先校验：

| 文件 | 用途 |
|---|---|
| `examples/policy/minimal-v1.json` | 最小可用、原始语义 |
| `examples/policy/observe-first.json` | 先观察包安装 |
| `examples/policy/tighten.json` | 直接禁 force-push 与 `.git` 写入 |
| `examples/policy/relax-with-guard.json` | 全局 observe，危险子集仍 deny |

`test/examples.test.mjs` 会校验每一份，模板不会腐坏。

## 改前改后都问一句

```
node tools/check.mjs --policy path/to/policy.json --validate
node tools/check.mjs --tool pwsh --args '{"command":"Remove-Item D:\\work\\a.txt -Force"}' --json
```

第一条回答"文件合法吗"（0 合法、1 不合法）；第二条回答"现在这条命令会被怎么判"，
用的是宿主同一个 `evaluate()`，不写审计。要复现工作区相关的判定就加 `--cwd`。

## 常见错误

| 错误 | 结果 |
|---|---|
| `version: 1` 里写 `allow` | 整份被拒（`allow-requires-v2`），继续用上一份好策略 |
| `version: 1` 里写 `observe` | 同上（`observe-requires-v2`） |
| `version: 1` 里写 `entries` | 同上（`entries-require-v2`） |
| `rules.quiet` 与 `rules.destructive.workspaceQuiet` 同时存在 | 被拒（`quiet-duplicate`） |
| `selfProtect.mode: "off"` | 被拒（`self-protect-not-disableable`） |
| `critical.mode: "observe"` | 被拒（`critical-mode-invalid`） |
| 正则没写 `^` | 被拒（`command-matches-unanchored`） |
| `when` 里写相对路径 | 被拒（`path-shape`） |

## 需要知道的边界

`observe` 与 `allow` 不会让护栏更安全，只会更安静。这里没有沙箱：宿主之外的进程、
绕过解析器的编码/拼接，都在这条线之外。插件依赖什么、宿主改了会怎样，见
`docs/DSH-API.md`。
