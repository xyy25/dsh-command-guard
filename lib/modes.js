// 命令审核档位（guard mode）模型。
//
// 档位决定"一条命令在何时被判定为需要用户确认"：
//   - rules             —— 使用配置里的硬规则引擎自动判定（插件原有逻辑）
//   - agent-*           —— 把命令交给 agent(LLM) 自审：模型对命令输出风险等级
//                          (safe/low/medium/high/critical) 与用途、影响，
//                          达到所选档位的阈值即触发用户确认卡片。
//
// 阈值语义（风险等级从低到高）：
//   agent-very-loose    —— 仅当 agent 判定 critical 时确认（最少打扰）
//   agent-loose         —— high 及以上确认
//   agent-standard      —— medium 及以上确认
//   agent-strict        —— low 及以上都确认（仅 "safe" 放行；存疑即确认）
//
// 客户端（src/client）有一份镜像常量，因为 client bundle 是独立产物，不能 import 本文件。
/** 风险等级 → 权重。 */
export const RISK_RANK = Object.freeze({
    safe: 0,
    low: 1,
    medium: 2,
    high: 3,
    critical: 4,
});
/** 档位机器值。 */
export const MODE_IDS = Object.freeze([
    "rules",
    "agent-very-loose",
    "agent-loose",
    "agent-standard",
    "agent-strict",
]);
/** 默认档位（配置与设置都未指定时）。 */
export const DEFAULT_MODE = "rules";
/**
 * 档位元数据表。zh/en 名称与说明用于 settings schema 的 const description（client 下拉）；
 * threshold 仅对 agent 档有意义——agent 判定 risk 达到该等级即触发确认。
 */
export const MODE_DEFS = Object.freeze([
    {
        id: "rules",
        zhName: "硬规则判定",
        zhDetail: "由插件的规则与配置自动判定（现有行为）；命中即向你确认",
        enName: "Hard rules",
        enDetail: "Decide by the configured rule engine (existing behavior); ask when a rule hits",
        threshold: null,
    },
    {
        id: "agent-very-loose",
        zhName: "Agent 判定 · 极宽松",
        zhDetail: "仅当 agent 判定为 critical（不可逆破坏）时才确认",
        enName: "Agent · very loose",
        enDetail: "Confirm only when the agent rates the command critical (irreversible destruction)",
        threshold: "critical",
    },
    {
        id: "agent-loose",
        zhName: "Agent 判定 · 宽松",
        zhDetail: "agent 判定为 high 及以上（明显破坏性）时确认",
        enName: "Agent · loose",
        enDetail: "Confirm when the agent rates the command high or above",
        threshold: "high",
    },
    {
        id: "agent-standard",
        zhName: "Agent 判定 · 标准",
        zhDetail: "agent 判定为 medium 及以上（有副作用）时确认",
        enName: "Agent · standard",
        enDetail: "Confirm when the agent rates the command medium or above",
        threshold: "medium",
    },
    {
        id: "agent-strict",
        zhName: "Agent 判定 · 严格",
        zhDetail: "agent 判定为 low 及以上（存疑即确认），仅明显安全的命令放行",
        enName: "Agent · strict",
        enDetail: "Confirm any command the agent does not rate safe; only clearly safe commands pass",
        threshold: "low",
    },
]);
/** id → 元数据。 */
const MODE_INDEX = new Map(MODE_DEFS.map((def) => [def.id, def]));
/**
 * 规范化档位值：未知/非法值回落默认档位。
 * @param value 任意输入
 * @returns 合法档位 id
 */
export function modeOf(value) {
    return typeof value === "string" && MODE_INDEX.has(value) ? value : DEFAULT_MODE;
}
/** 是否属于"交给 agent 判定"的档位。 */
export function isAgentMode(mode) {
    return mode.startsWith("agent-");
}
/** 取某档触发阈值（agent 档）；非 agent 档返回 null。 */
export function thresholdOf(mode) {
    return MODE_INDEX.get(modeOf(mode))?.threshold ?? null;
}
/**
 * agent 档是否应对该风险等级触发确认。
 * @param mode 已规范化的 agent 档位
 * @param risk 模型给出的风险等级
 */
export function shouldWarnForRisk(mode, risk) {
    const threshold = thresholdOf(mode);
    if (threshold === null)
        return false;
    const rank = RISK_RANK[risk];
    if (!Number.isInteger(rank))
        return false;
    return rank >= RISK_RANK[threshold] && risk !== "safe";
}
/** 全部档位元数据的浅拷贝列表（供配置 schema / 日志）。 */
export function listModeDefs() {
    return MODE_DEFS.map((def) => ({ ...def }));
}
