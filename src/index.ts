// dsh-command-guard 插件入口（宿主侧）。
//
// 能力：监听 `tools/pre-execute` waterfall，在 agent 调用 shell 类工具
// （默认 pwsh / bash）之前自动审核 `command` 参数。
//
// 风险命令一律改为"在界面弹确认卡片向用户询问"（除非启用 directDeny
// 硬拦截底线）：用户允许才放行本次调用，用户拒绝（或确认不可用）则
// 作为 deny 返回给 agent，绝不静默放行未确认的风险命令。
//
// 审核档位（见 ./modes.ts）：
//   - rules（默认）           —— 硬规则引擎自动判定，命中达到阈值 → 确认卡片
//   - agent-very-loose/loose/standard/strict —— 交给 agent(LLM) 自审，
//        模型输出风险等级与用途/影响，达到档位阈值 → 确认卡片
//
// 档位来源优先级：当前会话事件 `command-guard/mode` → 设置默认档位
// （settings namespace "commandGuard"）→ 插件 config.mode → "rules"。
//
// UI 询问基于 `ctx.userQuestions.ask`（web 端渲染为富文本卡片，阻塞
// 工具调用直到用户回答）。仅当调用方是 live root agent 且存在 UI provider
// 时才可用；子代理 / 无 agent 上下文 / provider 缺失 / 用户取消时
// fail closed 为 deny。

import z from "@deepseek-ai/schemastery";
import { DEFAULT_ALLOW_COMMANDS, DEFAULT_RULES, type RuleDef } from "./rules.js";
import { compilePatterns, compileRules, decideCommand, previewCommand, describeRule, type Rule, type Decision } from "./risk.js";
import { reviewWithLlm, reviewByAgent } from "./llm.js";
import { MODE_IDS, DEFAULT_MODE, modeOf, isAgentMode, shouldWarnForRisk } from "./modes.js";
import { buildAskDetail, buildShortReason, buildDenyReason } from "./gate.js";

/** 插件名称与宿主依赖（loader 用）。 */
export const name = "command-guard";
export const inject = ["tools"];

/** 会话事件类型：当前会话命令审核档位切换。 */
const MODE_EVENT = "command-guard/mode";
/** settings 命名空间：默认档位（新会话）。 */
const MODE_SETTINGS_NS = "commandGuard";

/** 确认卡片上的两个选项文案。 */
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

/** 会话事件的最小形状（只读取 fold 需要的字段）。 */
interface SessionEventLike {
  type?: string;
  data?: { mode?: unknown };
}

/** 会话的最小面：可读事件、可 append 新事件。 */
interface SessionLike {
  events: SessionEventLike[];
  append(type: string, data: unknown): void;
}

/** 从会话事件中折叠最近的档位事件。 */
function modeFromEvents(events: readonly SessionEventLike[] | null | undefined, fallback: string): string {
  if (!Array.isArray(events)) return fallback;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event && event.type === MODE_EVENT && event.data && typeof event.data.mode === "string") {
      return modeOf(event.data.mode);
    }
  }
  return fallback;
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

/** userQuestions 答案（宽松）。 */
interface UserAnswer {
  answers?: { id?: unknown; selected?: unknown[] }[];
}

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
        const fallback = defaultModeSource();
        const current = agent ? modeFromEvents(agent.session.events, fallback) : fallback;
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
        if (agent) agent.session.append(MODE_EVENT, { mode: normalized });
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
    const fallback = defaultModeSource();
    const mode = exec.agent ? modeFromEvents(exec.agent.session.events, fallback) : fallback;

    try {
      const decision = await decide(ctx, exec, command, mode);
      switch (decision.kind) {
        case "allow": {
          log("info", `allow  ${exec.name} ${JSON.stringify(preview)}（mode=${mode}）`);
          return next();
        }
        case "ask": {
          log("warn", `ask   ${exec.name} ${JSON.stringify(preview)}（mode=${mode}：${decision.reason ?? ""}）`);
          // 走 UI 确认卡片：向用户询问是否继续执行，并阻塞本次调用
          const outcome = await askUserViaUi(ctx, exec, decision);
          if (outcome === "allow") return next();
          const byUser = outcome === "deny";
          const reasonText = byUser
            ? decision.reason ?? "用户拒绝了命令审核"
            : `${decision.reason ?? "命令审核"}；且无法弹窗向用户确认（无 UI 或调用方不受支持），已阻止执行`;
          return {
            kind: "deny",
            reason: buildDenyReason({ command: preview, reason: reasonText, byUser }),
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
    // directDeny=true → 直接拒绝；否则一律转 UI 询问
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
    // 命中达到 askMinLevel 的规则 → 询问
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
   * agent 档：把命令交给 agent(LLM) 自审，达到档位阈值 → 询问。
   * 规则命中（达到 askMinLevel，但未到 denyMinLevel 的 critical）作为上下文
   * 传给用户卡片；agent 判定不可用时按 config.agentFallback 回落。
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
          // 回落规则引擎：命中达到 askMinLevel → 询问；否则放行
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

    // agent 判定达到档位阈值 → 询问（卡片内含 agent 的用途/影响说明）
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

/**
 * 通过 userQuestions 在界面弹确认卡片，等待用户选择，阻塞本次调用。
 * @returns "allow"=用户允许；"deny"=用户拒绝；"unavailable"=确认不可用（调用方转 deny）。
 */
async function askUserViaUi(ctx: HostContext, exec: ExecLike, decision: { detail: string; reason: string }): Promise<"allow" | "deny" | "unavailable"> {
  const userQuestions = ctx.get("userQuestions") as
    | { ask(request: Record<string, unknown>): Promise<UserAnswer> }
    | undefined;
  const agent = exec.agent;
  if (userQuestions === undefined || agent === undefined) {
    // 无 UI provider / 无 agent 上下文：fail closed（调用方转 deny）
    return "unavailable";
  }
  try {
    const answer = await userQuestions.ask({
      agent,
      signal: exec.signal,
      questions: [{
        id: `command-guard:${String(exec.callId ?? "call")}`,
        header: "命令审核",
        question: "Agent 请求执行一条被判定为有风险的命令，是否允许执行？",
        detail: decision.detail,
        options: [
          { label: UI_OPTIONS.allow, description: "仅允许本次调用执行" },
          { label: UI_OPTIONS.deny, description: "不执行；Agent 会收到提示并调整命令" },
        ],
      }],
    });
    const selected = answer?.answers?.[0]?.selected;
    if (Array.isArray(selected) && selected.includes(UI_OPTIONS.allow)) return "allow";
    return "deny";
  } catch (error) {
    ctx.logger.warn(`[command-guard] 用户确认不可用：${error instanceof Error ? error.message : String(error)}`);
    return "unavailable";
  }
}
