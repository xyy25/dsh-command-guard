# dsh-command-guard

DeepSeek Harness（dsh）插件：**自动审核 agent 发出的 shell 命令，对风险命令弹出本插件自绘的"命令审核"确认卡询问用户是否继续执行**（警告样式与沙箱拦截一致），用户允许才放行、拒绝则告知 agent —— 不再静默放行未确认的风险命令，也不默认直接拦截。

审核**档位**可由用户在界面上切换：

| 档位 | 判定方式 | 触发确认 |
|---|---|---|
| `rules`（默认） | 插件内置/配置的**硬规则引擎**（原有逻辑） | 命中达到 `askMinLevel`（默认 high）的规则 |
| `agent-very-loose` | 交给 **agent 自审**（LLM 像 agent 一样评估命令） | 仅 agent 判定 `critical` |
| `agent-loose` | 同上 | agent 判定 `high` 及以上 |
| `agent-standard` | 同上 | agent 判定 `medium` 及以上 |
| `agent-strict` | 同上 | agent 判定 `low` 及以上（存疑即确认） |

确认卡本体（样式、按钮、输入框、`guard-review` 接管）**全部实现在本插件的
client bundle 内**（`GuardApprovalCard`），宿主经 harness 的 `userQuestions`
seam 把问题推给卡片，无需改 dsh 源码：

- 与沙箱拦截同款的警告样式；`reason`/`detail` 含**命令预览**与**判定说明**
  （agent 档还含模型给出的**命令用途**与**可能影响**）。
- 右下角按钮一次点击生效；按钮左侧有**输入框**：留空时右侧为「拒绝」；
  **输入内容后「拒绝」自动变为「提交」**——点击即拒绝并把输入内容作为
  "用户希望：…"反馈给 agent（agent 可据此调整命令）。
- 自绘卡不可用的场景（无 UI provider、非 live root agent/子代理、用户取消、
  异常）自动**回落 harness approval seam**（`dsh-user-approval` 原生批准框 /
  按 approval 策略处理），同样不会放行未确认命令。

> 历史说明：早期版本曾把会话档位用 `agent.session.append("command-guard/mode", …)`
> 写入 harness 会话日志——自定义事件类型不在 harness 的冻结事件清单里，会让该会话
> 日志在重新加载时整体报 `SessionFormatUnsupportedError` 或迁移拒绝（历史不可读）。
> 注意 **dsh v0.1.5 起，迁移链连带 `ignorable: true` 的未知事件也拒绝**，因此早前
> “给自定义事件打 ignorable 标记”的临时修复在新版已失效；受污染的历史会话需要用
> `tools/repair-session-logs.mjs` 清理（见「dsh v0.1.5 会话格式迁移与历史会话修复」）。
> 现档位为进程内记忆、自绘卡走 `userQuestions`（question 交互不写入会话事件），
> 均不触碰 harness 会话日志。

## 行为总览

- 命中**极高危规则**（如根目录删除、格式化磁盘、关闭安全防护）：默认**弹确认卡询问用户**；
  可开启 `directDeny` 恢复为"直接拒绝、不弹框"（适合无人值守时的硬拦截底线）。
- 命中**高危规则**（rules 档，如普通删除、破坏性 git、`Invoke-Expression` 等）：弹确认卡。
- **白名单 / 未命中规则**：正常放行（白名单永远不能覆盖规则判定）。
- **agent 档**：规则只在两种情况下先行生效——白名单放行、极高危规则（受 `directDeny` 影响）；
  其余交给 agent 自审，按档位阈值决定是否确认。
- 所有询问都**阻塞本次工具调用**，直到用户在卡上做出决定：允许 → 放行本次调用；
  拒绝 → agent 收到拒绝原因（如填了输入框则附"用户希望：…"）并可调整命令。
- 无法弹卡的场景（子代理、无 UI、调用被中止）自动回落到 approval seam 处理，
  绝不静默放行未确认的风险命令。

## 安装与界面入口

1. 安装（以 `web` profile 为例）：

   ```sh
   dsh plugin --profile web add link:G:\dsh-dev\plugins\dsh-command-guard
   ```

   若 pnpm 不在 PATH，可改用 corepack：

   ```sh
   cd ~/.dsh/profiles/web
   corepack pnpm add link:G:\dsh-dev\plugins\dsh-command-guard
   ```

2. 在 `~/.dsh/profiles/web/cordis.patch.yml`（profile 的用户 patch 层）中追加：

   ```yaml
   - insert:
       - id: command-guard
         name: 'dsh-command-guard'
   ```

3. 重启 profile 生效（host 逻辑与客户端 UI 都需要重新装载）：

   ```sh
   dsh web
   ```

插件提供的界面入口（客户端 UI 随包分发，无需额外安装）：

> **客户端兼容提示（v0.1.2 与 v0.1.5 均可用）**：dsh v0.1.2 起客户端改为
> “module table + 平台 seed” 机制，第三方 client bundle 只能 require 平台 seed
> （react 系等）。本插件的 client bundle 只 require `react`，因此在 v0.1.2 与
> v0.1.5 下都能装载；确认卡、输入区「命令审核」按钮、`/guard` 弹层装饰均已提供
> （见下方“dsh 客户端兼容”）。

- **输入框工具栏**：权限选择器同排的常驻「命令审核」按钮——**仅图标**（盾形守卫），不占宽度；点击**向上**展开五档下拉、选择即切换当前会话档位。当前档位通过图标的**颜色与符号**区分（硬规则=蓝色字母 R，Agent 各档按阈值由浅到深、点数 1–4 递增），把鼠标悬停在图标上可看到档位全名；打开菜单**不会**在会话中产生额外的状态行。
- **斜杠命令 `/guard`**：输入 `/` 的候选菜单选中 `/guard`，或直接输入 `/guard` 后回车，都会**弹出档位下拉框**；带参形式 `/guard agent-standard` 直接切换。
- **默认档位（新会话）**：host 侧通过 settings 命名空间 `commandGuard` 注册
  （见 `src/index.ts`），可被 dsh 的设置界面读取/修改；注册不可用时回落到
  `cordis.patch.yml` 里的 `config.mode`。输入区的档位按钮只**读取**它来显示默认档，
  不执行任何命令。

## dsh 客户端兼容（v0.1.2 / v0.1.5 / 0.2.0）

dsh v0.1.2 引入 `dsh-client-modules`（boot 图 + module table），v0.1.5 与 0.2.0 沿用同一机制。

- **平台 seed**：v0.1.2 为 `react`、`react/jsx-runtime`、`react-dom`、`@deepseek-ai/cordis`、
  `@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、
  `@deepseek-ai/dsh-client-ui-primitives`；v0.1.5 起新增 `react-dom/client` 与
  `@deepseek-ai/dsh-client-ui-dockkit`（**超集，向后兼容**）。第三方 client bundle 只能
  require seed 词；旧版 bundle 里 `require("@deepseek-ai/dsh-client-runtime/client")`
  （该包已移除）会直接导致 client 装载失败（“missed the module table … build-time externals drift”）。
- **bundle 协议**：`window.__ModuleLoader__.load({ id, factory })` 三个版本一致，
  本插件的 `client/client.js` 同时适用（只 require `react`）。
- **用到的客户端契约**：

  | 契约 | v0.1.2 | v0.1.5 | v0.2.0 |
  |---|---|---|---|
  | `commandUi`（`decorate` + `kind: "popupSelect"`） | ✓ | ✓ | ✓ |
  | `conversation.composer`（chain，按 priority 升序选举） | ✓ | ✓ | ✓ |
  | `conversation.input.left`（`inject: (sessionId) => …`） | ✓ | ✓ | ✓ |
  | `sessions.binding(id)?.session` / `session.command()` | ✓ | ✓ | ✓ |
  | 设置读取 `settingsScope.describe()` | ✓ | ✓ | **改为 `configForms.describe()`**（结构相同；旧名仍作为回退） |

- **确认卡**：通过 `conversation.composer` 槽位接管 `intent.kind === "guard-review"` 的
  pending question（对 `PendingQuestion` 做鸭子类型，不 import 官方实现包），一次点击
  允许/拒绝、输入框“提交”等交互保持。dsh 0.2.0 起该槽明确“按 priority 升序选举、首个非
  null 生效”，本插件 `priority: -20` 先于官方 `0`，**0.2.0 无需让位补丁**；0.1.x 仍建议跑
  `tools/patch-dsh-composer-guard-review.mjs`。
- **档位默认值**：客户端只**读取**设置快照来显示默认档（0.1.x 的 namespace `commandGuard`；
  0.2.0+ 的插件 entry id，通常是 `command-guard`），**不执行任何命令**——早期“进入会话即调用
  `/guard` 查询当前档”的实现会让每次打开会话都多出一条 `guard · …` 状态行，现已修复。
- **宿主契约**：

  | 契约 | v0.1.2 | v0.1.5 | v0.2.0 |
  |---|---|---|---|
  | `tools/pre-execute` waterfall（`exec = {name, arguments, agent?}`） | ✓ | ✓ | ✓ |
  | `ctx.userQuestions.ask`（`intent.kind` 无白名单，校验 approve/detail） | ✓ | ✓ | ✓ |
  | `commands.register({name, description, input:{hint}, handler})` | ✓ | ✓ | ✓ |
  | `settings.register(ns, schema, {base})` | ✓ | ✓ | **已移除**（`SettingsForms`；设置表单由插件 `Config` 自动派生，值就是 config） |

- **0.2.0 的 peerDependencies 校验**：dsh 用 `semver.satisfies(runtime, range, {includePrerelease:true})`
  检查所有 `@deepseek-ai/dsh*` peer。`^0.1.1-rc.1` 的 caret 上界是 `<0.2.0-0`，**不覆盖
  `0.2.0-rc.2`**，因此本插件的 peer 范围已改为 `"^0.1.1-rc.1 || ^0.2.0-rc.1"`（同时匹配
  0.1.2 / 0.1.5 / 0.2.0 / 0.2.1）。
- **构建**：`client/client.js` 由 `src/client/client.tsx` 经 `tsc` 与
  `build/bundle-client.mjs` 生成（只 require `react`），**不要手改产物**。

## "帮我批准"模式（Full access + 命令审核代批）

参考 Codex 的 **"帮我批准（仅对检测到的风险操作请求批准）"**：dsh 预设表里没有现成的
"Full access 能力 + 只对风险命令询问"组合——`danger-full-access` 预设捆绑
`approval: never`（完全不问），`workspace-write` 捆绑 `ask` 但文件能力受限。做法是
**自定义一个权限预设**，在 `~/.dsh/profiles/web/cordis.patch.yml` 追加：

```yaml
- id: permission
  config:
    presets:
      read-only: { sandbox: read-only, approval: ask }
      workspace-write: { sandbox: workspace-write, approval: ask }
      danger-full-access: { sandbox: danger-full-access, approval: never }
      guarded:
        sandbox: danger-full-access   # Full access 的文件能力
        approval: ask                 # 但 approval 走询问
        name: 帮我批准（命令审核）
        description: Full access + 自动命令审核：仅检测到的风险命令请求批准
```

重启 profile 后，权限下拉会出现第 4 项「帮我批准（命令审核）」。切换后效果：

| 命令 | 结果 |
|---|---|
| 白名单 / 未命中规则 / medium 及以下 | command-guard 在 pre-execute 直接放行，**无弹窗** |
| 命中 `askMinLevel`（默认 high）规则 | **弹插件确认卡**（输入框 + 一次点击；不可用时回落 approval seam 弹窗）（允许 → 放行，拒绝 → 不执行） |
| 命中 `denyMinLevel`（critical）且 `directDeny: true` | 直接拒绝 |
| 非 shell 工具（读文件、检索等） | 照常执行，Full access 能力不受影响 |

> 信任边界：该预设没有 sandbox 兜底，命令是否执行取决于审核判定（rules 规则引擎或
> agent 自审）。想收紧可调 `askMinLevel`/`directDeny`/`disabledRuleIds`，或用 `agent-*`
> 档让模型按阈值裁决。建议配合 `rules` 档（确定性）使用。

## 配置

在 `cordis.patch.yml` 的 entry 中通过 `config` 覆盖。完整示例：

```yaml
- insert:
    - id: command-guard
      name: 'dsh-command-guard'
      config:
        enabled: true                 # 总开关
        tools: [pwsh, bash]           # 审核哪些工具
        mode: rules                   # 默认档位（rules / agent-very-loose / agent-loose / agent-standard / agent-strict）
        directDeny: false             # true：命中 denyMinLevel 的命令直接拒绝（不询问）；默认询问
        denyMinLevel: critical        # directDeny=true 时的直拒底线
        askMinLevel: high             # rules 档触发询问的最低级别（可调 medium 收紧）
        agentFallback: rules          # agent 自审不可用时的回落：rules / allow / ask
        logDecisions: true            # 每次决策写入日志
        maxCommandPreviewBytes: 300   # 日志与短原因中的命令预览长度
        # 额外白名单（正则，忽略大小写；不能覆盖规则判定）
        allowCommands:
          - '^npm\s+run\b'
        # 禁用部分默认规则
        disabledRuleIds:
          - rmdir-empty
        # 追加自定义规则（level: low | medium | high | critical）
        rules:
          - id: my-danger
            level: high
            pattern: '\bRemove-SomethingDangerous\b'
            description: 自定义危险命令
            hint: 自定义提示
        # 旧版 LLM 兜底（仅 rules 档、对未命中规则的命令生效；agent 档请用 mode: agent-*）
        llm:
          enabled: false
          # provider: my-provider     # 缺省取调用 agent 的 provider/model
          # model: my-model
          timeoutMs: 15000
          allowOnFailure: true        # 审核失败/超时时是否放行；false 则降级为询问确认
```

优先级（从高到低）：极高危规则（`directDeny` 直接拒绝 / 否则批准框询问）→ 白名单 → agent 自审或 rules 阈值 → 默认放行。**白名单永远不能覆盖规则判定**——这是安全兜底。

## 默认规则摘要

| 级别 | 覆盖场景 |
|---|---|
| critical | 根目录递归删除（`rm -rf /` 等）、格式化/清空磁盘（`Format-Volume`/`diskpart`）、关闭 Defender/防火墙 |
| high | 任何删除（`rm`/`Remove-Item`/`del`/`rd` 等）、清空内容、注册表删除、破坏性 git（强推/硬重置/clean/删分支/改写历史）、DROP/TRUNCATE/无 WHERE 的 DELETE/UPDATE、服务停止/删除、关机重启、`Invoke-Expression`/`eval`、下载脚本直接执行、放宽执行策略、账户/用户组管理、凭据导出、远程会话 |
| medium | 敏感文件读取（`.env`/`id_rsa` 等）、系统目录写入、容器删除/停止、kill 进程、权限修改、全局包卸载、删除空目录 |

完整规则见 `src/rules.ts`（产物在 `lib/rules.js`）。

## Agent 档（交给 agent 自审）说明

- agent 档复用调用方 agent 的 provider/model（或 `llm.provider`/`llm.model` 显式指定），每条命令触发一次轻量模型调用（`temperature=0`，输出 JSON）。
- 模型输出 `{"risk":"safe|low|medium|high|critical","purpose":"一句话用途","impact":"一句话影响"}`；
  `purpose`/`impact` 会随确认卡的判定说明一并展示，供用户快速理解。
- agent 自审失败/超时/无路由时按 `agentFallback` 处理（默认回落规则引擎，避免"失效即放行"）。
- 即使处于 agent 档，**critical 级硬规则**仍先于 agent 判定（`directDeny=false` 时询问、`true` 时直接拒绝），保证底线不被模型误判绕过。

## dsh 会话格式迁移与历史会话修复（v0.1.5 / 0.2.0）

dsh v0.1.5 引入了**冻结的会话格式迁移链**（`v0 → v1 → v2 → v3`），v0.2.0 又追加
`v3 → v4`（当前版本 v4，由 `dsh-session-format-catalog` 装配）。规则是：**v0 → v1 的迁移
只接受冻结清单内的事件类型，连带 `ignorable: true` 的未知事件也直接拒绝**，于是整个会话
被判为不可读：

```text
历史加载失败：failed to observe session "…": format v0 contains unknown historical
event type "command-guard/mode" at seq 103636; migration refuses unknown historical
events even when ignorable; source v0 artifact remains unchanged
```

修复工具是 `tools/repair-session-logs.mjs`（**只改会话日志数据，不改 dsh 源码**）。
按现象归为三类：

| 类别 | 现象 | 脚本处置 |
|---|---|---|
| **A** 未知事件类型 | 早期版本写入的 `command-guard/mode`（或任何第三方自定义事件） | **删除该事件**，并把其后所有序号引用整体前移（seq 必须稠密） |
| **B** 已知事件的多余 payload 成员 | 例如 `permission/preset` 里多出 `origin`（dsh 自身冻结清单的缺口，与本插件无关） | **删除多余成员**（按 `assertReleasedEventPayload` 的报错逐项定位） |
| **C** 关系校验失败 | 例如 `assistant/message repeats advertised tool call …` | **不自动修复**（牵涉消息内容与工具调用生命周期），脚本如实报告并保持文件原样 |

### 用法

```sh
cd G:\dsh-dev\plugins\dsh-command-guard

# 1) 只读检查：列出每个会话的问题与修复项（默认模式，不写盘）
node tools/repair-session-logs.mjs

# 2) 确认后写盘修复（自动备份为 <文件>.pre-repair.bak）
node tools/repair-session-logs.mjs --apply

# 其它
node tools/repair-session-logs.mjs --only <sessionId>   # 只处理匹配的会话
node tools/repair-session-logs.mjs --undo               # 从备份还原
node tools/repair-session-logs.mjs --dsh "<dsh-root>"   # 显式指定 dsh 安装目录
```

> 执行 `--apply` 前建议**完全退出 dsh**：Windows 上活跃会话的日志文件可能被占用，
> 会导致写盘失败（脚本会明确提示）。

脚本行为：

- 先做**严格帧扫描**（与 dsh 的 `scanZstdFrames` 同语义）再逐帧解压，不靠魔数猜帧；
- 删事件前会检查：被删事件不落在打包行（`text-chunks`/`reasoning-chunks`/`tool-call-chunks`）
  的序号区间内，且没有任何 `sourceEventSeqs`/`surfaceOp`/`shadowedSeqs`/`shadowedRange`/
  `messageSeqs`/`sourceEventSeq`/`throughSeq` 引用它——任一不满足即拒绝自动修复；
- **只处理 v0 文件**（先只读 header 判断版本）；v1+ 是 dsh 迁移的产物，脚本直接标记
  「已是新版」并跳过，绝不用 v0 词汇表去改它；
- 修复后用**自检**验证：seq 稠密、冻结清单、payload 语义，以及
  `assertReleasedArtifactRelationships` 的关系校验（能检出 C 类）；不通过就不写盘。
  **不再调用** catalog 的 `createRestore(validation:"current")`——dsh 0.2.0 的 `v3→v4`
  迁移需要“子会话 catalog 事实”，单文件校验提供不了，会误报
  `V3 catalog migration requires explicit historical child facts…`；
- 写回时保持 **frame 0 恰好一行 header** + 单事件帧（与 dsh 自身的写回格式一致）；
- 幂等：已修复或本来就干净的会话显示为「干净」。

### 重要提示

- 修复后的会话仍是 v0 格式；**首次被 dsh 打开时会自动迁移到当前格式（0.2.0 下是 v4）并
  写回文件**。那之后 **旧版 dsh 将无法再读这些会话**。脚本保留的 `<文件>.pre-repair.bak`
  是唯一回退凭据。
- 升级 dsh 不会影响已迁移的会话；但**不要**随意把 `.pre-repair.bak` 还原回去。
- 本脚本面向 dsh **v0.1.5+**（依赖 `dsh-session-format-v0-to-v1` 的冻结清单）。旧版 dsh
  不需要修复：当时的迁移器容忍 `ignorable: true` 的未知事件。
- 若报告 `不可自动修复 … repeats advertised tool call`：这是历史日志本身的不一致
  （同一步内重复广播同一 tool-call），与插件无关，需人工重建或等上游修复。

## 安装后处理：question intent 白名单补丁（仅 dsh v0.1.1-rc.x 需要）

插件自绘的"命令审核"确认卡依赖宿主发出 `intent.kind = "guard-review"` 的问题。
在 **dsh v0.1.1-rc.x** 中，harness 的 userQuestions wire schema 把 `intent.kind`
限定为只允许 `"plan-review"`（`dsh-client-connection` 与 `dsh-host-apiproxy`
两处 zod `discriminatedUnion`）；未知 intent 会在浏览器端解码时整帧被丢弃
（控制台可见 `ZodError … options: ["plan-review"]`），表现为不弹卡、宿主
`ask` 挂起转圈。

**dsh v0.1.2+ 已移除该帧级白名单，guard-review 无需任何补丁。** 脚本会自动
检测：目标文件已无 `plan-review` 锁时打印“新版无需补丁”并正常退出（可直接
运行一次确认）。

### 运行补丁脚本（仅旧版）

```sh
cd G:\dsh-dev\plugins\dsh-command-guard
node tools/patch-dsh-question-intent.mjs --dsh "E:\\nvm4w\\nodejs\\node_modules\\@deepseek-ai\\dsh"
```

- `--dsh` 指向 `@deepseek-ai/dsh` 包安装目录（本机示例；也可设环境变量 `DSH_ROOT`）。
- 脚本**幂等**；每次真实修改前备份为 `<文件>.bak-intent-guard-review`；
  修改后用 `node --check` 校验；需重启 dsh 生效。

### 回滚

```sh
node tools/patch-dsh-question-intent.mjs --dsh "<dsh-root>" --undo
```

### 版本升级后

- 升级到 **v0.1.2 / v0.1.5+**：本脚本无需处理（自动自检放行）；如残留 v0.1.1 打的补丁，
  可运行 `--undo` 还原成官方文件。**但另外两个补丁脚本必须重跑**（见“升级 dsh 后的补丁清单”）。
- 仍在 **v0.1.1-rc.x**：升级 dsh 会覆盖被打补丁的两个文件，需重跑一次脚本。

## 安装后处理：composer 让位补丁（v0.1.2 / v0.1.5；0.2.0 起无需）

`conversation.composer` 是 chain/overlay 槽：渲染器按顺序遍历 occupant 的 `select`，
只渲染**第一个**返回非 null 的。官方 `dsh-client-ui-user-questions` 的 occupant 对
**所有** `PendingQuestion`（含 `guard-review`）都返回自身，第三方 occupant 永远轮不到；
而官方槽渲染还要求 occupant 携带私有 `store` face，第三方无法在该槽自绘（直接注册会让
输入区崩溃）。因此 0.1.x 需要一处最小补丁：让官方对 `intent.kind === "guard-review"`
返回 `null`，把链继续交给本插件的 `GuardApprovalCard`；plan-review 与普通提问行为不变。

该表达式在 v0.1.2 与 v0.1.5 的
`node_modules/@deepseek-ai/dsh-client-ui-user-questions/lib/client.js` 中逐字符一致。

**dsh 0.2.0 起不需要这个补丁**：`conversation.composer` 仍是 chain 槽，注册时按
`priority ?? 0` 升序排序、`renderSlotChain` 取第一个非 null；本插件 occupant 的
`priority: -20` 先于官方 `0`，`select` 会直接接管 `guard-review`。脚本因此默认跳过，
只有 `--force` 才真的打补丁（实测万一未接管时的兜底）。

```sh
node tools/patch-dsh-composer-guard-review.mjs --check   # 只探测；0.2.0 会提示 skipped
node tools/patch-dsh-composer-guard-review.mjs           # 0.2.0 默认跳过；0.1.x 打补丁
node tools/patch-dsh-composer-guard-review.mjs --force   # 0.2.0 也强制打补丁
node tools/patch-dsh-composer-guard-review.mjs --undo    # 从备份还原
```

> 为什么确认卡里的 `detail`（命令预览与判定说明）必须按**纯文本**渲染：早期实现在该槽位
> 用官方 `MarkdownText` 渲染 detail，触发槽渲染异常（输入区整体消失、`slot entry crashed
> in 'conversation.composer'`）。现实现用 `<pre>` 原样显示文本，两个版本下均稳定。

## 安装后处理：guarded 权限图标补丁（v0.1.2 / v0.1.5 / 0.2.0）

权限下拉只对设计集内的预设画图标，profile patch 新增的 `guarded` 会落到
`permissionGlyph() === undefined` 的“无图标”分支。脚本在 `permissionGlyphs` Map 里插入
「盾牌 + 几何化字母 G」的 16×16 图标，与 read-only 的对勾、danger-full-access 的感叹号区分开。

**目标文件随版本变化**（脚本自动探测，取第一个含 `permissionGlyphs` 的文件）：

| dsh 版本 | 目标文件 |
|---|---|
| 0.2.0+ | `node_modules/@deepseek-ai/dsh-client-ui-permission-presets/lib/client.js`（权限选择器已迁出 conversation） |
| 0.1.x | `node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js` |

插入的 svg 是**自包含**的（不引用目标文件里的 `shieldOutline` 等变量），因此同一条目在两处都可用。

```sh
node tools/patch-dsh-permission-glyph.mjs --check   # 只探测，不写
node tools/patch-dsh-permission-glyph.mjs           # 打补丁（备份 .bak-permission-glyph）
node tools/patch-dsh-permission-glyph.mjs --undo    # 从备份还原
```

> **为什么脚本要做 Map 语义校验**：`permissionGlyphs` 的最后一项通常**没有尾随逗号**。若把新
> 条目插到 Map 闭合 `]);` **之前**却不补逗号，JS 会把 `[FULL_ACCESS, …)]` 换行
> `["guarded", …)]` 解析成**索引访问**（换行不触发 ASI），该元素求值为 `undefined`，于是
> `new Map([…, undefined])` 在运行时抛 `TypeError: Iterator value undefined is not an entry
> object`，dsh 启动时报 `failed to import loader entry … (@deepseek-ai/dsh-client-ui-conversation)`。
> `node --check` 只查语法（`[a][b]` 是合法语法）**发现不了**这类错误，所以本脚本现在：把新条目插到
> `const permissionGlyphs = new Map([` **之后**（新条目自带尾随逗号），并在写盘前把 Map 片段真正
> 求值一次（条目数 +1 且含 `guarded` 才写盘），任何一步失败都从备份回滚。
>
> 若已经看到上述 `Iterator value undefined` 报错：执行
> `node tools/patch-dsh-permission-glyph.mjs --undo` 还原，然后用当前版本的脚本重跑即可。

## 升级 dsh 后的补丁清单

dsh 升级会覆盖 `node_modules`，因此**每次升级后都要重跑**（三个脚本都支持 `--check`
只探测、`--undo` 还原，并在真实修改前各自备份）：

| 脚本 | 何时需要 |
|---|---|
| `tools/patch-dsh-question-intent.mjs` | 仅 v0.1.1-rc.x；v0.1.2+ 自动跳过 |
| `tools/patch-dsh-composer-guard-review.mjs` | v0.1.2 / v0.1.5 需要；**v0.2.0+ 自动跳过**（priority 选举已生效，`--force` 可覆盖） |
| `tools/patch-dsh-permission-glyph.mjs` | v0.1.2 / v0.1.5 / **v0.2.0** 都需要（目标文件随版本自动切换） |

三个脚本都会自动探测 dsh 安装目录（当前 `node` 可执行文件推导 → `npm root -g` → 已知
路径形态），也可用 `--dsh "<root>"` 或环境变量 `DSH_ROOT` 显式指定。本机
`E:\nvm4w\nodejs` 是指向 `E:\nvm\v24.14.1` 的**符号链接**，两个路径等价。

## 源码与构建（TypeScript / TSX）

插件源码用 TypeScript 编写并构建为运行时产物（**逻辑不变，改动一律走源码 + 重新构建**）：

| 目录 | 内容 | 说明 |
|---|---|---|
| `src/*.ts` | 宿主侧逻辑（无 React） | 档位模型、规则、决策引擎、LLM 调用、插件装配 |
| `src/client/client.tsx` | 客户端 UI（含 React/DOM） | 设置行、`/guard` 弹层、输入区下拉 |
| `lib/*.js` | **构建产物**（宿主 ESM） | `tsc -p tsconfig.json` 生成 |
| `client/client.js` | **构建产物**（web bundle） | `tsc -p src/client/tsconfig.json` 出 CJS → `build/bundle-client.mjs` 包成 `__ModuleLoader__.load` 外壳 |
| `build/`、`tsconfig.json`、`src/client/tsconfig.json` | 构建链 | 无第三方构建依赖，只用 `typescript` |
| `tools/*.mjs` | 会话修复与 dsh 安装后处理脚本 | 见「dsh v0.1.5 会话格式迁移与历史会话修复」「安装后处理」；**由用户手动执行** |

```sh
cd plugins/dsh-command-guard
# 首次需安装开发依赖（含 typescript；离线环境可把依赖装进本仓库 node_modules）
npm install --no-audit --no-fund --ignore-scripts
npm run build     # 编译 src/*.ts → lib/*.js，src/client/client.tsx → client/client.js
npm test          # 先构建再跑测试
```

## 开发与测试

```sh
cd plugins/dsh-command-guard
# 安装开发依赖（peer 依赖；离线环境可用 junction 指向 dsh checkout 的 node_modules）
npm install --no-audit --no-fund --ignore-scripts
npm run build
npm test
```

- `test/run.js` —— 决策引擎/档位模型/agent 评审解析/原因组装等单元测试（34 项，无外部依赖）。
- `test/integration.js` —— 用真实 cordis Context 加载插件并触发 `tools/pre-execute` 的接线测试（26 项）：
  ask/deny/allow 决策、自绘确认卡（允许/拒绝/输入框提交/回落）、`directDeny`、agent 档阈值与回落、
  `/guard` 档位切换不写会话事件等。
- 注意：宿主/客户端改动请编辑 `src/`（含 React 的用 `.tsx`，其余用 `.ts`），**不要手改 `lib/` 与 `client/` 产物**——它们是构建生成物，会被 `npm run build` 覆盖。

## 常见问题

- **dsh 启动时报 `Plugin dsh-command-guard@0.1.0 is incompatible with dsh 0.2.0-rc.2`？** 这是
  dsh 0.2.0 新增的 peerDependencies 校验：`^0.1.1-rc.1` 的 caret 上界是 `<0.2.0-0`，不覆盖
  `0.2.0-rc.2`。本插件包已把 peer 范围改为 `"^0.1.1-rc.1 || ^0.2.0-rc.1"`；用 profile 重新
  `dsh plugin add` 后即消失。临时绕过可用 `dsh plugin allow-version` 授予豁免（不推荐长期用）。
- **Windows 弹出“应用程序无法正常启动（0xc0000142）”？** 与插件无关，通常是瞬时资源压力
  （例如一次性解压大量会话日志）或安全软件导致的进程初始化失败。关掉提示、重启 dsh 即可；
  排查会话时优先用 `repair-session-logs.mjs` 的只读模式（它只读 header，不会全量解压）。

- **为什么有时看到的是插件的确认卡，有时是 harness 原生的批准框？** 正常情况下（web UI 会话、
  live root agent）弹**插件自绘的确认卡**（含输入框，有内容时"拒绝"变"提交"）。自绘卡不可用的场景
  （子代理、无 userQuestions provider、用户取消、异常）会自动**回落** harness 的 approval seam，
  由原生批准框或 approval 策略处理——两者都不会放行未确认的风险命令。
- **为什么切换档位后重启 dsh 又变回默认档？** 会话档位保存在插件进程内，不写入 harness 会话日志。
  原因：harness 会话日志只接受冻结的事件词汇表，写入插件自定义事件类型（旧版 `command-guard/mode`）
  会让整个会话历史在重载时报 `SessionFormatUnsupportedError`，**dsh v0.1.5 起更会因格式迁移
  直接拒绝该会话**（连 `ignorable: true` 也不放行）。如需跨重启固定档位，请用设置命名空间
  `commandGuard` 的**默认档位**（或 `cordis.patch.yml` 的 `config.mode`）。
- **升级 dsh 后某几个历史会话打不开了，怎么办？** 多为早期 `command-guard/mode` 事件或
  `permission/preset.origin` 触发 v0.1.5 的迁移拒绝。运行
  `node tools/repair-session-logs.mjs`（只读检查）确认，再 `--apply` 修复；详见「dsh v0.1.5
  会话格式迁移与历史会话修复」。
- **权限菜单里「帮我审核」没有图标？** dsh 升级覆盖了 `node_modules`，重跑
  `node tools/patch-dsh-permission-glyph.mjs` 并重启 dsh、强刷浏览器即可。
- **风险命令不再弹我插件的确认卡，而是原生的批准框？** 先确认 composer 让位补丁是否还在：
  `node tools/patch-dsh-composer-guard-review.mjs --check`；dsh 升级后需要重跑。
- **`directDeny` 是什么？** 默认所有风险命令（含 `rm -rf /`）都弹确认卡询问；`directDeny: true` 后，
  命中 `denyMinLevel`（默认 critical）的命令直接拒绝、不再询问，适合无人值守的硬拦截场景。
- **为什么我把某命令加进 `allowCommands` 仍被拦？** 规则优先级高于白名单；请调整 `askMinLevel`/
  `denyMinLevel`/`directDeny` 或删除/降级对应规则。
- **`git checkout -- .` 这类恢复操作也会问？** 是的，它会丢弃工作区改动，属数据丢失风险，rules 档默认询问。
- **`Format-Table`/`Format-Hex` 这类只读命令也会被当作"格式化磁盘"？** 不会。format-disk 规则只匹配
  `Format-Volume`/`Clear-Disk`/`diskpart` 等卷操作与带盘符的 `format C:`；裸 `format` 已从规则中移除（回归测试覆盖）。
- **agent 档会不会每一条命令都调用模型？** 会为每一条未命中白名单的命令做一次轻量自审；档位越宽松
  判定后触发询问越少，档位不改变是否调用的行为。若不需要 agent 自审，使用 `rules` 档即可。
