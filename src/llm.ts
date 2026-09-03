// LLM 审核调用（agent 自审 / 旧版 rules 兜底共用一套骨架）。
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import {
  buildReviewPrompt,
  parseVerdict,
  buildAgentReviewPrompt,
  parseAgentReview,
  type Verdict,
  type AgentReview,
} from "./llm-verdict.js";

/** llm 配置片段（provider/model 与超时；来源于插件 Config.llm）。 */
export interface LlmConfigLike {
  provider?: string;
  model?: string;
  timeoutMs?: number;
}

/** tools/pre-execute 的 exec 的最小类型面（只读所需字段）。 */
export interface ToolExecLike {
  name: string;
  agent?: {
    options?: { provider?: string; model?: string };
  };
  signal?: { aborted: boolean; addEventListener(type: string, listener: () => void, options?: unknown): void; removeEventListener(type: string, listener: () => void): void };
}

/** 宿主 ctx 最小类型面。 */
export interface PluginCtxLike {
  get(name: string): unknown;
}

const SYSTEM_PROMPT = "你是命令安全审核器。只输出 JSON，不要输出其他任何内容。";

/**
 * 把 llmConfig 中的 provider/model 与调用 agent 的选项合并，
 * 解析出用于一次审核调用的 provider/model。
 */
function resolveLlmTarget(exec: ToolExecLike, llmConfig: LlmConfigLike): { provider: string; model: string } | undefined {
  const agentOptions = exec.agent?.options;
  const provider = llmConfig.provider ?? agentOptions?.provider;
  const model = llmConfig.model ?? agentOptions?.model;
  if (typeof provider !== "string" || typeof model !== "string") return undefined;
  return { provider, model };
}

/** 返回模型流式文本：把一次 LLM 审核调用跑完并拼接文本。 */
async function collectStreamText(
  llm: { stream(options: Record<string, unknown>): unknown },
  options: Record<string, unknown>,
): Promise<string> {
  let text = "";
  const stream = llm.stream(options) as AsyncIterable<{ type?: string; text?: string }>;
  for await (const chunk of stream) {
    if (chunk.type === "text-delta") text += chunk.text ?? "";
    if (chunk.type === "finish") break;
  }
  return text;
}

/**
 * 用 LLM 审核一条命令（旧版 rules 档兜底，verdict 为 allow/ask/deny）。
 * @returns 无法解析 provider/model、无 llm 服务或解析失败时返回 undefined。
 */
export async function reviewWithLlm(
  ctx: PluginCtxLike,
  exec: ToolExecLike,
  command: string,
  llmConfig: LlmConfigLike,
): Promise<Verdict | undefined> {
  const llm = ctx.get("llm") as { stream(options: Record<string, unknown>): unknown } | undefined;
  if (llm === undefined) return undefined;
  const target = resolveLlmTarget(exec, llmConfig);
  if (target === undefined) return undefined;

  const timeoutMs = Number.isFinite(llmConfig.timeoutMs) ? llmConfig.timeoutMs : 15000;
  const timeoutController = new AbortController();
  const cleanup = watchAbort(exec, timeoutMs, timeoutController);

  try {
    const userMessage = createUserMessage({
      content: [{ type: "text", text: buildReviewPrompt(command, exec.name) }],
      source: { kind: "plugin", plugin: "command-guard", form: "notice", summary: "命令安全审核" },
    });
    const text = await collectStreamText(llm, {
      provider: target.provider,
      model: target.model,
      system: SYSTEM_PROMPT,
      messages: [userMessage],
      temperature: 0,
      maxTokens: 128,
      stop: ["\n\n"],
      signal: timeoutController.signal,
    });
    return parseVerdict(text);
  } finally {
    cleanup();
  }
}

/**
 * Agent 自审：调用 LLM 让"agent 审核自己将要执行的命令"，
 * 返回风险等级与用途/影响说明（后两者将展示给用户）。
 * @param tier 档位后缀（very-loose|loose|standard|strict），影响判定尺度
 * @returns 无法解析 provider/model、无 llm 服务、超时或解析失败时返回 undefined。
 */
export async function reviewByAgent(
  ctx: PluginCtxLike,
  exec: ToolExecLike,
  command: string,
  tier: string,
  llmConfig: LlmConfigLike,
): Promise<AgentReview | undefined> {
  const llm = ctx.get("llm") as { stream(options: Record<string, unknown>): unknown } | undefined;
  if (llm === undefined) return undefined;
  const target = resolveLlmTarget(exec, llmConfig);
  if (target === undefined) return undefined;

  const timeoutMs = Number.isFinite(llmConfig.timeoutMs) ? llmConfig.timeoutMs : 15000;
  const timeoutController = new AbortController();
  const cleanup = watchAbort(exec, timeoutMs, timeoutController);

  try {
    const userMessage = createUserMessage({
      content: [{ type: "text", text: buildAgentReviewPrompt(command, exec.name, tier) }],
      source: { kind: "plugin", plugin: "command-guard", form: "notice", summary: "命令安全审核" },
    });
    const text = await collectStreamText(llm, {
      provider: target.provider,
      model: target.model,
      system: SYSTEM_PROMPT,
      messages: [userMessage],
      temperature: 0,
      maxTokens: 320,
      stop: ["\n\n"],
      signal: timeoutController.signal,
    });
    return parseAgentReview(text);
  } finally {
    cleanup();
  }
}

/** 建立一次审核调用的超时与中止监听（返回清理函数）。 */
function watchAbort(
  exec: ToolExecLike,
  timeoutMs: number,
  timeoutController: AbortController,
): () => void {
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
  const onExecAbort = () => timeoutController.abort();
  if (exec.signal?.aborted) timeoutController.abort();
  else exec.signal?.addEventListener("abort", onExecAbort, { once: true });
  return () => {
    clearTimeout(timer);
    exec.signal?.removeEventListener("abort", onExecAbort);
  };
}
