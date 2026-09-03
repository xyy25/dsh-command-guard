// dsh-command-guard 插件入口（宿主侧）。
//
// 能力：监听 `tools/pre-execute` waterfall，在 agent 调用 shell 类工具
// （默认 pwsh / bash）之前自动审核 `command` 参数。
//
// 风险命令一律返回 `{ kind: "ask", reason }` 决策，由 harness 的
// `tools/pre-execute` approval seam（`dsh-user-approval`，web/terminal UI
// 原生弹批准框）询问用户：允许才放行本次调用，拒绝则 harness 返回 deny，
// 无 approval 通道时由平台 fail closed 拒绝。除非启用 directDeny 硬拦截
// 底线（命中达到 denyMinLevel 直接 `{ kind: "deny" }`）。
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
//
// 询问机制也不要绕道 `ctx.userQuestions.ask`：该服务注册在 agent/会话
// 作用域，profile 级插件上下文通常取不到（结果为"无法弹窗"并 fail
// closed）。正确做法是让 listener 返回 ask 决策，由 dsh-tools 在正确的
// 作用域里路由到 approval seam。

import z from "@deepseek-ai/schemastery";
import { DEFAULT_ALLOW_COMMANDS, DEFAULT_RULES, type RuleDef } from "./rules.js";
import { compilePatterns, compileRules, decideCommand, previewCommand, describeRule, type Rule, type Decision } from "./risk.js";
import { reviewWithLlm, reviewByAgent } from "./llm.js";
import { MODE_IDS, DEFAULT_MODE, modeOf, isAgentMode, shouldWarnForRisk } from "./modes.js";
import { buildAskDetail, buildShortReason } from "./gate.js";

/** 插件名称与宿主依赖（loader 用）。 */
export const name = "command-guard";
export const inject = ["tools"];

/** settings 命名空间：默认档位（新会话）。 */
const MODE_SETTINGS_NS = "commandGuard";

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

/** 会话的最小面：只需要稳定 id（本插件不再读写 harness 会话事件）。 */
interface SessionLike {
  id?: string;
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

  /**
   * 会话级档位覆盖（/guard <mode> 切换的结果）。
   * 仅在本进程内按会话 id 记忆——不要写进 harness 会话日志（自定义事件
   * 类型会导致日志无法重放，见文件头注释）。进程重启后新会话回落默认档。
   */
  const sessionModes = new Map<string, string>();

  /** 当前会话档位：会话覆盖 → 默认档。 */
  function currentModeOf(session: SessionLike | undefined | null): string {
    const id = sessionIdOf(session);
    if (id !== undefined && sessionModes.has(id)) return sessionModes.get(id)!;
    return defaultModeSource();
  }

  // ---------- settings：默认档位（新会话；复用 host settings 服务） ----------
  ctx.inject(["settings"], (settingsCtx: any) => {
    const schema = z.object({
      mode: z.union(
        MODE_IDS.map((id) => z.const(id).description(modeLabel(id))),
      ).required(),
    });
    try {
      const scope = settingsCtx.settings.register(MODE_SETTINGS_NS, schema, {
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
          if (id !== undefined) sessionModes.set(id, normalized);
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
          // 返回 ask 决策，由 harness 的 approval seam（dsh-user-approval，
          // dsh-tools serviceAsk）在 agent 作用域弹原生批准框并等待用户。
          // 不要在此处自行调用 userQuestions/阻塞 IO：profile 级插件
          // 上下文取不到会话级 UI 服务，会导致"无法弹窗"而 fail closed。
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

