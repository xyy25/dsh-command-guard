// dsh-command-guard 插件入口（宿主侧）。
//
// 能力：监听 `tools/pre-execute` waterfall，在 agent 调用 shell 类工具
// （默认 pwsh / bash）之前自动审核 `command` 参数。
//
// 风险命令的询问采用"插件自绘确认卡优先、harness approval seam 兜底"
// 双通道：
//   - 优先：通过 `ctx.userQuestions.ask`（guard-review intent）弹**本插件
//     client 自绘的警告卡**（与沙箱拦截同款样式；右下角按钮一次点击生效；
//     左侧输入框有内容时"拒绝"变"提交"，文本作为"用户希望…"随拒绝返回）。
//     UI 与接管（GuardApprovalCard / conversation.composer）都在本插件
//     client bundle 内，不依赖改 dsh 源码。
//   - 回落：自绘卡不可用（无 userQuestions provider / 非 live root agent /
//     子代理 / 用户取消 / 异常）时，返回 `{ kind: "ask", reason }` 交给
//     harness approval seam（`dsh-user-approval`）弹原生批准框或按策略
//     拒绝，绝不放行未确认的风险命令。除非启用 directDeny 硬拦截底线
//     （命中达到 denyMinLevel 直接 `{ kind: "deny" }`）。
//
// 审核档位（见 ./modes.ts）：
//   - rules（默认）           —— 硬规则引擎自动判定，命中达到阈值 → ask
//   - agent-very-loose/loose/standard/strict —— 交给 agent(LLM) 自审，
//        模型输出风险等级与用途/影响，达到档位阈值 → ask
//
// 档位来源优先级：当前会话档位（本进程内按会话 id 记忆，见下）→ 设置
// 默认档位（settings namespace "commandGuard"）→ 插件 config.mode → "rules"。
//
// 注意：不要用 `agent.session.append()` 写入自定义事件类型（例如
// "command-guard/mode"）。harness 的会话事件词汇表
// （@deepseek-ai/dsh-session 的 KNOWN_SESSION_EVENT_TYPES）是编译期固定的，
// 不包含任何 out-of-repo 插件事件；这类事件一旦落盘，重新加载该会话时
// persistence 会以 SessionFormatUnsupportedError 拒绝整份日志（除非事件带
// `ignorable: true`，而 append() 并不开放该标记）。因此会话档位只在
// 本进程内记忆，不做跨重启持久化。

import z from "@deepseek-ai/schemastery";
import { Service } from "@deepseek-ai/cordis";
import { SessionModeStore } from "./session-modes.js";
import { DEFAULT_ALLOW_COMMANDS, DEFAULT_RULES, type RuleDef } from "./rules.js";
import { compilePatterns, compileRules, decideCommand, previewCommand, describeRule, type Rule, type Decision } from "./risk.js";
import { reviewWithLlm, reviewByAgent } from "./llm.js";
import { MODE_IDS, DEFAULT_MODE, modeOf, isAgentMode, shouldWarnForRisk } from "./modes.js";
import { buildAskDetail, buildShortReason } from "./gate.js";

/** 插件名称与宿主依赖（loader 用）。 */
export const name = "command-guard";
export const inject = ["tools", "webServer"];

/** settings 命名空间：默认档位（新会话）。 */
const MODE_SETTINGS_NS = "commandGuard";

/** 自绘确认卡上的选项文案（一次点击生效；拒绝侧输入框有内容时变"提交"）。 */
const UI_OPTIONS = Object.freeze({
  allow: "允许执行",
  deny: "拒绝执行",
});

/**
 * 运行配置（结构定义见 Config）。apply 收到的是经 z 校验后的值。
 * 这里用同构的宽松接口便于内部类型标注。
 */
interface GuardConfig {
  enabled: boolean;
  tools: string[];
  mode: string;
  directDeny: boolean;
  agentFallback: "rules" | "allow" | "ask";
  allowCommands: string[];
  rules: RuleDef[];
  disabledRuleIds: string[];
  askMinLevel: string;
  denyMinLevel: string;
  logDecisions: boolean;
  maxCommandPreviewBytes: number;
  queryModeOnOpen: boolean;
  llm: { enabled: boolean; provider?: string; model?: string; timeoutMs: number; allowOnFailure: boolean };
}

/** 运行配置（schemastery schema，供 loader 校验与文档化）。 */
export const Config = z.object({
  /** 总开关。 */
  enabled: z.boolean().default(true),
  /** 要审核的工具名列表。 */
  tools: z.array(z.string()).default(["pwsh", "bash"]),
  /** 默认档位（settings/会话事件未指定时的兜底）。 */
  mode: z.union(MODE_IDS).default(DEFAULT_MODE),
  /**
   * 命中达到 denyMinLevel 的命令是否直接拒绝（不弹卡）。
   * 默认 false：极高危命令也一律询问用户。
   */
  directDeny: z.boolean().default(false),
  /**
   * agent 自审不可用（无 llm 路由/超时/解析失败）时的回落策略：
   * rules=用规则引擎再判定；allow=放行；ask=直接要求确认。
   */
  agentFallback: z.union(["rules", "allow", "ask"]).default("rules"),
  /** 额外白名单（字符串正则，忽略大小写），与默认白名单合并。 */
  allowCommands: z.array(z.string()).default([]),
  /** 额外风险规则（追加到默认规则之后），字段同默认规则。 */
  rules: z.array(z.object({
    id: z.string(),
    level: z.union(["low", "medium", "high", "critical"]),
    pattern: z.string(),
    description: z.string(),
    hint: z.string(),
  })).default([]),
  /** 禁用的默认规则 id。 */
  disabledRuleIds: z.array(z.string()).default([]),
  /** 触发用户询问的最低级别（rules 档与 agentFallback=rules 生效）。 */
  askMinLevel: z.union(["low", "medium", "high", "critical"]).default("high"),
  /** directDeny=true 时触发直接拒绝的最低级别。 */
  denyMinLevel: z.union(["low", "medium", "high", "critical"]).default("critical"),
  /** 是否把每次审核决策写入日志。 */
  logDecisions: z.boolean().default(true),
  /** 命令预览的最大字节数（用于日志与短原因）。 */
  maxCommandPreviewBytes: z.number().min(16).default(300),
  /**
   * 允许客户端在展开档位菜单时查询一次真实档位（执行 /guard 无参）。
   * 查询会写 command/run + command/done 两条**官方**事件；客户端按会话缓存
   * 12 小时，因此每个会话最多产生一次这样的记录。默认 true（显示准确优先）；
   * 想彻底避免留痕可设为 false。
   */
  queryModeOnOpen: z.boolean().default(true),
  /**
   * 可选 LLM 审核（仅 rules 档对未命中规则的命令生效，向后兼容旧版；
   * agent 档请改用 mode: agent-*）。agent-* 档复用其中的
   * provider/model/timeoutMs。
   */
  llm: z.object({
    enabled: z.boolean().default(false),
    provider: z.string(),
    model: z.string(),
    timeoutMs: z.number().default(15000),
    allowOnFailure: z.boolean().default(true),
  }).default({} as never),
});

/** 档位中文名称（settings schema const description / 日志）。 */
const MODE_LABEL_ZH: Readonly<Record<string, string>> = Object.freeze({
  rules: "硬规则判定",
  "agent-very-loose": "Agent 判定 · 极宽松",
  "agent-loose": "Agent 判定 · 宽松",
  "agent-standard": "Agent 判定 · 标准",
  "agent-strict": "Agent 判定 · 严格",
});

function modeLabel(id: string): string {
  return MODE_LABEL_ZH[id] ?? id;
}

/** 会话的最小面：稳定 id + header.parentSession（分支继承用）。 */
interface SessionLike {
  id?: string;
  header?: { parentSession?: string };
  parentSession?: string;
}

/** 取会话的持久 id（无会话/无 id 时返回 undefined）。 */
function sessionIdOf(session: SessionLike | undefined | null): string | undefined {
  return session !== undefined && session !== null && typeof session.id === "string"
    ? session.id
    : undefined;
}

// ---- 宿主 ctx / exec 的宽松结构（仅声明插件用到的面，避免引入重型类型依赖）----

/** 宿主 context 的最小面。 */
interface HostContext {
  get(name: string): unknown;
  logger: {
    info(message?: unknown, ...args: unknown[]): void;
    warn(message?: unknown, ...args: unknown[]): void;
    error(message?: unknown, ...args: unknown[]): void;
    debug?(message?: unknown, ...args: unknown[]): void;
    success?(message?: unknown, ...args: unknown[]): void;
  };
  on(event: string, listener: (...args: any[]) => any): () => void;
  inject(deps: string[], callback: (ctx: any) => void): void;
  effect(callback: (() => void | (() => void)) | (() => Promise<void>), label?: string): void;
}

/** tools/pre-execute 的 exec 与 pre-tool 决策的最小面。 */
interface ExecLike {
  name: string;
  callId?: unknown;
  arguments?: { command?: unknown; [key: string]: unknown };
  signal?: { aborted: boolean; addEventListener(type: string, listener: () => void, options?: unknown): void; removeEventListener(type: string, listener: () => void): void };
  agent?: {
    options?: { provider?: string; model?: string };
    session: SessionLike;
  };
}

interface RuleLike {
  id: string;
  level: string;
  pattern: string;
  description?: string;
  hint?: string;
}

/** 决策对象（index 内部使用，决策阶段不含用户交互 IO）。 */
type GuardDecision =
  | { kind: "allow" }
  | { kind: "ask"; detail: string; reason: string }
  | { kind: "deny"; reason: string };

export function apply(ctx: HostContext, config: GuardConfig): void {
  if (!config.enabled) return;

  // 编译规则与白名单（一次编译，全程复用）
  const defaultRules = DEFAULT_RULES.filter((rule) => !config.disabledRuleIds.includes(rule.id));
  const rules: readonly Rule[] = compileRules([...defaultRules, ...config.rules]);
  const allowPatterns: readonly RegExp[] = compilePatterns([...DEFAULT_ALLOW_COMMANDS, ...config.allowCommands]);

  if (rules.length === 0 && allowPatterns.length === 0) {
    ctx.logger.warn("[command-guard] 没有可用的规则与白名单，插件不生效；请检查 disabledRuleIds / rules / allowCommands 配置");
  }

  const log = (level: "info" | "warn", message: string, meta?: unknown): void => {
    if (!config.logDecisions) return;
    ctx.logger[level](`[command-guard] ${message}`, meta ?? "");
  };

  /** 档位默认值：settings 注册成功 → settings 当前值；否则 config.mode。 */
  let defaultModeSource = (): string => config.mode;

  // 会话级档位：持久化到插件自己的 JSON 文件（绝不写 harness 会话事件），
  // 解析顺序 = 本会话记录 → 父会话继承（分支）→ 默认档。
  const modeStore = new SessionModeStore({ logger: ctx.logger });
  modeStore.load();

  // SSE 订阅者：档位切换后向已连接的客户端推送 {sessionId, mode}。
  // 走 /api/command-guard/events（与 task-board / dsh1024 同一套 webServer 路由）。
  const sseClients = new Set<any>();
  const broadcastMode = (sessionId: string, mode: string): void => {
    const payload = `data: ${JSON.stringify({ sessionId, mode })}\n\n`;
    for (const client of sseClients) {
      try {
        client.write(payload);
      } catch {
        sseClients.delete(client);
      }
    }
  };

  /** 当前会话档位（含分支继承）。 */
  function currentModeOf(session: SessionLike | undefined | null): string {
    return modeStore.resolve(session, defaultModeSource());
  }

  // typert：把"查询某会话档位"暴露成**只读**远程方法（不写任何会话事件）。
  // 客户端侧：ctx.inject(["remote.commandGuard"], (scope) => scope.remote.commandGuard.sessionMode(id))。
  //
  // 注意：cordis 的 `ctx.set(name, value)` 要求该名字**已经被 provide**，
  // 否则抛 "cannot set property without provide"（之前正是被 catch 吞掉，
  // 导致服务从未注册、客户端也拿不到 remote.commandGuard）。正确入口是 `ctx.provide`。
  try {
    (ctx as any).provide("commandGuard", {
      sessionMode(sessionId: string): { mode: string; source: string } {
        const id = typeof sessionId === "string" && sessionId !== "" ? sessionId : undefined;
        return { mode: modeStore.resolve({ id }, defaultModeSource()), source: "resolved" };
      },
    });
  } catch (error) {
    ctx.logger.warn(`[command-guard] typert 服务注册失败：${error instanceof Error ? error.message : String(error)}`);
  }

  // 查询 HTTP 路由：客户端用它读取会话档位（零会话事件）。
  // 路径按社区惯例放在 `/api/<plugin>/…` 下（@linxin666/dsh-client-ui-task-board 用
  // `/api/task-board`，dsh1024 用 `/dsh1024`），并同时接受 GET/POST：
  // 只读查询走 GET；POST 预留给未来可能的写入端点（参数一律走 query，不解析 body）。
  ctx.inject(["webServer"], (scope: any) => {
    const webServer = scope.webServer;
    if (webServer === undefined || typeof webServer.register !== "function") return;
    scope.effect(() => webServer.register({
      kind: "exact",
      path: "/api/command-guard/session-mode",
      handler: (req: any, res: any) => {
        if (req.method !== "GET" && req.method !== "POST") {
          res.statusCode = 405;
          res.setHeader("allow", "GET, POST");
          res.end();
          return;
        }
        const url = new URL(String(req.url ?? ""), "http://localhost");
        const sessionId = url.searchParams.get("sessionId") ?? "";
        const mode = modeStore.resolve({ id: sessionId }, defaultModeSource());
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ mode }));
      },
    }));
    // SSE：档位切换后实时推送 {sessionId, mode}（与 task-board 的
    // `EventSource("api/task-board/events")` 同一套机制）。
    scope.effect(() => webServer.register({
      kind: "exact",
      path: "/api/command-guard/events",
      handler: (req: any, res: any) => {
        if (req.method !== "GET") {
          res.statusCode = 405;
          res.setHeader("allow", "GET");
          res.end();
          return;
        }
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        res.write(": connected\n\n");
        sseClients.add(res);
        const cleanup = (): void => {
          sseClients.delete(res);
        };
        req.on("close", cleanup);
        res.on("close", cleanup);
      },
    }));
  });
  //
  // 排查结论（2026-xx，dsh 0.2.0-rc.2）：
  //   - connection 服务上**没有** register；正确入口是 connection.rpc.handle，
  //     但它内部用 owner.webServer 注册路由，而 owner 的 ctx 不含 webServer inject，
  //     调用即抛 "cannot get property "webServer" without inject"（官方没有任何插件使用该 API）；
  //   - connection.rpc.intercept 只接受 "/api"，且该共享 channel 已被 api-gateway 独占；
  //   - `/plugins/*` 被 dsh-client-modules 的 bundle 路由占用（只允许 GET/HEAD，其余 405）。
  // 因此客户端读档位走下面的只读 HTTP GET 路由（实测 200）。

  // 只读 HTTP 路由：客户端用它查询会话档位（零会话事件）。

  // ---------- settings：默认档位（新会话；复用 host settings 服务） ----------
  ctx.inject(["settings"], (settingsCtx: any) => {
    // dsh 0.2.0 起 settings 服务改为 SettingsForms：不再提供
    // register(ns, schema, { base })，设置表单由插件 Config 自动派生
    // （namespace 即 profile patch 里的 entry id，值就是 config）。
    // 因此 0.2.0+ 直接用 config.mode；只有 0.1.x 才注册独立 namespace。
    const settings = settingsCtx.settings;
    if (typeof settings?.register !== "function") return;
    const schema = z.object({
      mode: z.union(
        MODE_IDS.map((id) => z.const(id).description(modeLabel(id))),
      ).required(),
    });
    try {
      const scope = settings.register(MODE_SETTINGS_NS, schema, {
        base: { mode: modeOf(config.mode) },
      });
      defaultModeSource = () => modeOf(scope.get().mode);
      ctx.effect(() => () => {
        defaultModeSource = () => config.mode;
      });
    } catch (error) {
      ctx.logger.warn(`[command-guard] settings 注册失败，回退 config.mode：${error instanceof Error ? error.message : String(error)}`);
    }
  });

  // ---------- /guard 命令：查看 / 切换当前会话档位 ----------
  ctx.inject(["commands"], (commandCtx: any) => {
    commandCtx.commands.register({
      name: "guard",
      description: "查看或切换命令审核档位（rules / agent-*）",
      input: { hint: "<mode>" },
      handler: ({ agent, rawInput }: { agent?: { session: SessionLike }; rawInput: string }) => {
        const inputName = rawInput.trim();
        const session = agent?.session;
        const fallback = defaultModeSource();
        const current = session ? modeOf(currentModeOf(session)) : modeOf(fallback);
        if (inputName === "") {
          return { kind: "success", text: current };
        }
        const normalized = modeOf(inputName);
        if (normalized !== inputName) {
          return {
            kind: "error",
            text: `unknown guard mode "${inputName}" (available: ${MODE_IDS.join(", ")})`,
          };
        }
        if (session) {
          const id = sessionIdOf(session);
          if (id !== undefined) {
            modeStore.set(id, normalized, session.header?.parentSession ?? session.parentSession);
            // 推送：客户端据此实时更新档位图标（零会话事件）。
            broadcastMode(id, normalized);
          }
        }
        return { kind: "success", text: normalized };
      },
    });
  });

  // ---------- 预执行审核 ----------
  ctx.on("tools/pre-execute", async (exec: ExecLike, next: () => Promise<unknown>) => {
    // 只审核配置中的工具
    if (!config.tools.includes(exec.name)) return next();
    // 只审核带 command 字符串参数的工具调用
    const command = exec.arguments?.command;
    if (typeof command !== "string" || command.trim().length === 0) return next();

    const preview = previewCommand(command, config.maxCommandPreviewBytes);
    const mode = modeOf(currentModeOf(exec.agent?.session));

    try {
      const decision = await decide(ctx, exec, command, mode);
      switch (decision.kind) {
        case "allow": {
          log("info", `allow  ${exec.name} ${JSON.stringify(preview)}（mode=${mode}）`);
          return next();
        }
        case "ask": {
          log("warn", `ask   ${exec.name} ${JSON.stringify(preview)}（mode=${mode}：${decision.reason ?? ""}）`);
          // 1) 优先：插件自绘确认卡（与沙箱拦截同款警告样式 + 输入框：
          //    有内容时"拒绝"变"提交"，文本作为"用户希望…"随拒绝回传）。
          //    UI 与接管都在本插件 client（GuardApprovalCard / guard-review）。
          try {
            const outcome = await askViaGuardCard(ctx, exec, decision);
            if (outcome.action === "allow") return next();
            const customHint = outcome.custom !== undefined ? `；用户希望：${outcome.custom}` : "";
            return {
              kind: "deny",
              reason: `命令审核被用户拒绝${customHint}。命令：${JSON.stringify(preview)}。`,
            };
          } catch (error) {
            ctx.logger.warn(`[command-guard] 确认卡不可用，回落 harness approval seam：${error instanceof Error ? error.message : String(error)}`);
          }
          // 2) 回落：返回 ask 决策，由 harness approval seam（dsh-user-approval /
          //    dsh-tools serviceAsk）弹原生批准框；approval 策略 never 时直接拒绝。
          return {
            kind: "ask",
            reason: `命令审核：${decision.reason ?? "风险命令需要确认"}。命令：${JSON.stringify(preview)}。请确认是否允许执行。`,
          };
        }
        case "deny": {
          const reason = `命令审核拒绝：${decision.reason ?? "被直接拒绝"}。命令：${JSON.stringify(preview)}。`;
          log("warn", `deny  ${exec.name} ${JSON.stringify(preview)}（mode=${mode}，directDeny）`);
          return { kind: "deny", reason };
        }
        default:
          return next();
      }
    } catch (error) {
      // 审核自身异常：fail closed，绝不放行未确认的风险命令
      ctx.logger.warn(`[command-guard] 审核异常，已拒绝：${error instanceof Error ? error.message : String(error)}`);
      return {
        kind: "deny",
        reason: `命令审核内部错误，命令未执行（${error instanceof Error ? error.message : String(error)}）。命令：${JSON.stringify(preview)}。`,
      };
    }
  });

  /**
   * 生成一次审核的决策（决策阶段不含用户交互 IO）。
   */
  async function decide(ctx: HostContext, exec: ExecLike, command: string, mode: string): Promise<GuardDecision> {
    // 规则引擎统一判定（内部顺序：规则命中 → 白名单 → 默认放行；
    // 白名单不会覆盖 high/critical 规则命中）
    const ruleDecision: Decision = decideCommand(command, {
      rules,
      allowPatterns,
      askMinLevel: config.askMinLevel,
      denyMinLevel: config.denyMinLevel,
    });

    // 命中达到 denyMinLevel 的规则（默认 critical 级）：
    // directDeny=true → 直接拒绝；否则一律转为 ask 决策
    // （这是安全底线，不交给 agent 放行）
    if (ruleDecision.kind === "deny") {
      if (config.directDeny) {
        return { kind: "deny", reason: describeRule(ruleDecision.rule) };
      }
      return {
        kind: "ask",
        detail: buildAskDetail({
          command,
          toolName: exec.name,
          mode: "rules",
          ruleLabel: ruleDecision.rule?.description,
          ruleHint: ruleDecision.rule?.hint,
        }),
        reason: describeRule(ruleDecision.rule),
      };
    }

    // 白名单放行（decideCommand 已保证此处未命中 high/critical）
    if (ruleDecision.source === "allowlist") {
      return { kind: "allow" };
    }

    // agent 档：命中 askMinLevel 规则的上下文 + 交给 agent 自审
    if (isAgentMode(mode)) {
      return decideByAgent(ctx, exec, command, mode, ruleDecision);
    }

    // ---- rules 档 ----
    // 命中达到 askMinLevel 的规则 → ask（approval seam）
    if (ruleDecision.kind === "ask") {
      return {
        kind: "ask",
        detail: buildAskDetail({
          command,
          toolName: exec.name,
          mode: "rules",
          ruleLabel: ruleDecision.rule?.description,
          ruleHint: ruleDecision.rule?.hint,
        }),
        reason: describeRule(ruleDecision.rule),
      };
    }

    // 未命中任何规则（source === "default"）→ 可选旧版 llm.enabled 兜底
    if (config.llm.enabled && ruleDecision.source === "default") {
      const llmDecision = await reviewWithLlm(ctx, exec, command, config.llm).catch((error: unknown) => {
        ctx.logger.warn(`[command-guard] LLM 兜底审核失败：${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      });
      if (llmDecision === undefined && !config.llm.allowOnFailure) {
        const reason = "LLM 兜底审核不可用，默认要求确认";
        return {
          kind: "ask",
          detail: buildAskDetail({ command, toolName: exec.name, mode: "rules", reason }),
          reason,
        };
      }
      if (llmDecision !== undefined && llmDecision.kind !== "allow") {
        const reason = llmDecision.reason || "LLM 兜底审核判定需要确认";
        return {
          kind: "ask",
          detail: buildAskDetail({ command, toolName: exec.name, mode: "rules", reason }),
          reason,
        };
      }
    }

    return { kind: "allow" };
  }

  /**
   * agent 档：把命令交给 agent(LLM) 自审，达到档位阈值 → ask。
   * 规则命中（达到 askMinLevel，但未到 denyMinLevel 的 critical）的说明
   * 并入 ask reason；agent 判定不可用时按 config.agentFallback 回落。
   */
  async function decideByAgent(
    ctx: HostContext,
    exec: ExecLike,
    command: string,
    mode: string,
    ruleDecision: Decision,
  ): Promise<GuardDecision> {
    const tier = mode.slice("agent-".length); // very-loose|loose|standard|strict

    const review = await reviewByAgent(ctx, exec, command, tier, config.llm).catch((error: unknown) => {
      ctx.logger.warn(`[command-guard] agent 自审失败：${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    });

    if (review === undefined) {
      switch (config.agentFallback) {
        case "allow":
          return { kind: "allow" };
        case "ask": {
          const reason = "agent 自审不可用，默认要求确认";
          return {
            kind: "ask",
            detail: buildAskDetail({ command, toolName: exec.name, mode, reason }),
            reason,
          };
        }
        case "rules":
        default: {
          // 回落规则引擎：命中达到 askMinLevel → ask；否则放行
          if (ruleDecision.kind === "ask" || ruleDecision.kind === "deny") {
            const reason = describeRule(ruleDecision.rule);
            return {
              kind: "ask",
              detail: buildAskDetail({
                command,
                toolName: exec.name,
                mode: "rules",
                ruleLabel: ruleDecision.rule?.description,
                ruleHint: ruleDecision.rule?.hint,
                reason: "agent 自审不可用，已回落到规则判定",
              }),
              reason: `${reason}（agent 自审不可用，回落规则判定）`,
            };
          }
          return { kind: "allow" };
        }
      }
    }

    // agent 判定达到档位阈值 → ask（reason 内含 agent 的用途/影响说明）
    if (shouldWarnForRisk(mode, review.risk)) {
      const contextRule = ruleDecision.kind !== "allow" && ruleDecision.rule
        ? { ruleLabel: ruleDecision.rule.description, ruleHint: ruleDecision.rule.hint }
        : {};
      return {
        kind: "ask",
        detail: buildAskDetail({
          command,
          toolName: exec.name,
          mode,
          agentReview: { risk: review.risk, purpose: review.purpose, impact: review.impact },
          ...contextRule,
        }),
        reason: buildShortReason({
          mode,
          agentReview: { risk: review.risk, purpose: review.purpose, impact: review.impact },
          reason: [review.purpose, review.impact].filter(Boolean).join("；"),
        }),
      };
    }

    return { kind: "allow" };
  }
}

/** userQuestions 应答的宽松面（selected=一次点击选项；custom=输入框"提交"文本）。 */
interface UserAnswerLike {
  answers?: { id?: unknown; selected?: unknown[]; custom?: unknown }[];
}

/**
 * 通过 userQuestions seam 弹插件的自绘确认卡（GuardApprovalCard），等待用户
 * 一次点击（允许执行 / 拒绝执行）或"提交"（拒绝 + 输入框文本）。
 * 仅当存在 UI provider 且调用方是 live root agent 时可用；任何不可用或
 * 异常都向上抛，由 ask 分支统一记录并回落 harness approval seam。
 */
async function askViaGuardCard(
  ctx: HostContext,
  exec: ExecLike,
  decision: { detail: string; reason: string },
): Promise<{ action: "allow" } | { action: "deny"; custom?: string }> {
  const userQuestions = ctx.get("userQuestions") as
    | { ask(request: Record<string, unknown>): Promise<UserAnswerLike> }
    | undefined;
  const agent = exec.agent;
  if (userQuestions === undefined || agent === undefined) {
    throw new Error("no user-questions provider or no agent context");
  }
  const answer = await userQuestions.ask({
    agent,
    signal: exec.signal,
    questions: [{
      id: `command-guard:${String(exec.callId ?? "call")}`,
      header: "命令审核",
      question: "Agent 请求执行一条被判定为有风险的命令，是否允许执行？",
      detail: decision.detail,
      // intent 让客户端把该请求渲染为插件的自绘确认卡（GuardApprovalCard），
      // 而非通用问答流。userQuestions.ask 会校验 approve 标签确有一个同名
      // option，且声明 intent 时 detail 必须存在。
      intent: { kind: "guard-review", approve: UI_OPTIONS.allow },
      options: [
        { label: UI_OPTIONS.allow, description: "仅允许本次调用执行" },
        { label: UI_OPTIONS.deny, description: "不执行；Agent 会收到提示并调整命令" },
      ],
    }],
  });
  const selected = answer?.answers?.[0]?.selected;
  const rawCustom = answer?.answers?.[0]?.custom;
  const custom = typeof rawCustom === "string" && rawCustom.trim() !== "" ? rawCustom.trim() : undefined;
  if (Array.isArray(selected) && selected.includes(UI_OPTIONS.allow)) return { action: "allow" };
  return custom === undefined ? { action: "deny" } : { action: "deny", custom };
}

