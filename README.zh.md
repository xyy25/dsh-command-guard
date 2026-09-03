# dsh-command-guard

DeepSeek Harness（dsh）插件：**自动审核 agent 发出的 shell 命令，对风险命令通过 harness 原生 approval 批准框询问用户是否继续执行**，用户允许才放行、拒绝则告知 agent —— 不再静默放行未确认的风险命令，也不默认直接拦截。

审核**档位**可由用户在界面上切换：

| 档位 | 判定方式 | 触发确认 |
|---|---|---|
| `rules`（默认） | 插件内置/配置的**硬规则引擎**（原有逻辑） | 命中达到 `askMinLevel`（默认 high）的规则 |
| `agent-very-loose` | 交给 **agent 自审**（LLM 像 agent 一样评估命令） | 仅 agent 判定 `critical` |
| `agent-loose` | 同上 | agent 判定 `high` 及以上 |
| `agent-standard` | 同上 | agent 判定 `medium` 及以上 |
| `agent-strict` | 同上 | agent 判定 `low` 及以上（存疑即确认） |

插件把风险命令作为 `{ kind: "ask", reason }` 决策交回 `tools/pre-execute` 流水线，由 harness 的 **approval seam**（`dsh-user-approval`，dsh-base 默认装载）弹出原生批准框；`reason` 中包含**命令预览**与**判定说明**（agent 档还包含模型给出的**命令用途**与**可能影响**）。

> 历史说明：早期版本曾用 `ctx.userQuestions.ask` 自绘"命令审核"确认卡，并用
> `agent.session.append("command-guard/mode", …)` 把会话档位写进 harness 会话日志。
> 前者在 profile 级插件上下文取不到（表现为"无法弹窗"后 fail closed），后者写出的
> 自定义事件类型不在 harness 的 `KNOWN_SESSION_EVENT_TYPES` 且无法标记 ignorable，
> 会让该会话日志重新加载时整体报 `SessionFormatUnsupportedError`（历史不可读）。
> 本版本已改为 approval seam + 进程内档位记忆，均不触碰 harness 会话日志。

## 行为总览

- 命中**极高危规则**（如根目录删除、格式化磁盘、关闭安全防护）：默认**弹批准框询问用户**；
  可开启 `directDeny` 恢复为"直接拒绝、不弹框"（适合无人值守时的硬拦截底线）。
- 命中**高危规则**（rules 档，如普通删除、破坏性 git、`Invoke-Expression` 等）：弹批准框。
- **白名单 / 未命中规则**：正常放行（白名单永远不能覆盖规则判定）。
- **agent 档**：规则只在两种情况下先行生效——白名单放行、极高危规则（受 `directDeny` 影响）；
  其余交给 agent 自审，按档位阈值决定是否确认。
- 所有询问都**阻塞本次工具调用**，直到用户在界面上做出决定（体验与沙箱拦截的审批一致）：
  允许 → 放行本次调用；拒绝 → agent 收到 `the user rejected tool ...` 并可调整命令。
- 无法询问的场景（子代理、无 approval 通道、调用被中止）一律 **fail closed** 拒绝并说明原因，
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

插件自带客户端 UI（随包分发，无需额外安装）：

- **输入框工具栏**：权限选择器同排的常驻「命令审核」按钮——**仅图标**（盾形守卫），不占宽度；点击**向上**展开五档下拉、选择即切换当前会话档位。当前档位通过图标的**颜色与符号**区分（硬规则=蓝色字母 R，Agent 各档按阈值由浅到深、点数 1–4 递增），把鼠标悬停在图标上可看到档位全名；打开菜单**不会**在会话中产生额外的状态行。
- **斜杠命令 `/guard`**：输入 `/` 的候选菜单选中 `/guard`，或直接输入 `/guard` 后回车，都会**弹出档位下拉框**；带参形式 `/guard agent-standard` 直接切换。
- **设置页 → General → "命令审核"**（"权限"行正下方）：选择**新会话的默认档位**。

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
  `purpose`/`impact` 会随批准框的 reason 一并展示，供用户快速理解。
- agent 自审失败/超时/无路由时按 `agentFallback` 处理（默认回落规则引擎，避免"失效即放行"）。
- 即使处于 agent 档，**critical 级硬规则**仍先于 agent 判定（`directDeny=false` 时询问、`true` 时直接拒绝），保证底线不被模型误判绕过。

## 源码与构建（TypeScript / TSX）

插件源码用 TypeScript 编写并构建为运行时产物（**逻辑不变，改动一律走源码 + 重新构建**）：

| 目录 | 内容 | 说明 |
|---|---|---|
| `src/*.ts` | 宿主侧逻辑（无 React） | 档位模型、规则、决策引擎、LLM 调用、插件装配 |
| `src/client/client.tsx` | 客户端 UI（含 React/DOM） | 设置行、`/guard` 弹层、输入区下拉 |
| `lib/*.js` | **构建产物**（宿主 ESM） | `npm run build` 由 `tsc -p tsconfig.host.json` 生成 |
| `client/client.js` | **构建产物**（web bundle） | `tsc` 编 CJS → `build/bundle-client.mjs` 包成 `__ModuleLoader__.load` 外壳 |
| `build/`、`tsconfig.*.json` | 构建链 | 无第三方构建依赖，只用 `typescript` |

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
- `test/integration.js` —— 用真实 cordis Context 加载插件并触发 `tools/pre-execute` 的接线测试（21 项）：
  ask/deny/allow 决策、approval 结果模拟、`directDeny`、agent 档阈值与回落、`/guard` 档位切换不写会话事件等。
- 注意：宿主/客户端改动请编辑 `src/`（含 React 的用 `.tsx`，其余用 `.ts`），**不要手改 `lib/` 与 `client/` 产物**——它们是构建生成物，会被 `npm run build` 覆盖。

## 常见问题

- **为什么有的风险命令直接报错而不是弹批准框？** 插件把风险命令作为 `ask` 决策交回 harness 的
  approval seam（`dsh-user-approval`，dsh-base 默认装载），由 web/terminal 界面原生弹出批准框。
  在子代理、无 approval 通道（部署未装载该服务）、用户取消或调用被中止时按 fail-closed 拒绝并说明原因。
- **为什么切换档位后重启 dsh 又变回默认档？** 会话档位保存在插件进程内，不写入 harness 会话日志。
  原因：harness 会话日志只接受编译期内置的事件词汇表，向其中写入插件自定义事件类型（旧版
  `command-guard/mode`）会让整个会话历史在重载时报 `SessionFormatUnsupportedError` 而不可读。
  如需跨重启固定档位，请用设置页"命令审核"行的**默认档位**。
- **`directDeny` 是什么？** 默认所有风险命令（含 `rm -rf /`）都弹批准框询问；`directDeny: true` 后，
  命中 `denyMinLevel`（默认 critical）的命令直接拒绝、不再询问，适合无人值守的硬拦截场景。
- **为什么我把某命令加进 `allowCommands` 仍被拦？** 规则优先级高于白名单；请调整 `askMinLevel`/
  `denyMinLevel`/`directDeny` 或删除/降级对应规则。
- **`git checkout -- .` 这类恢复操作也会问？** 是的，它会丢弃工作区改动，属数据丢失风险，rules 档默认询问。
- **`Format-Table`/`Format-Hex` 这类只读命令也会被当作"格式化磁盘"？** 不会。format-disk 规则只匹配
  `Format-Volume`/`Clear-Disk`/`diskpart` 等卷操作与带盘符的 `format C:`；裸 `format` 已从规则中移除（回归测试覆盖）。
- **agent 档会不会每一条命令都调用模型？** 会为每一条未命中白名单的命令做一次轻量自审；档位越宽松
  判定后触发询问越少，档位不改变是否调用的行为。若不需要 agent 自审，使用 `rules` 档即可。
