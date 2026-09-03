// 确认卡片与拒绝原因的纯组装函数（不依赖 cordis，便于单元测试）。
import { RISK_RANK } from "./modes.js";
/** 风险等级中文名（用于卡片展示）。 */
export const RISK_ZH = Object.freeze({
    safe: "安全",
    low: "低",
    medium: "中",
    high: "高",
    critical: "极高",
});
/** 风险等级排名（复用 modes 的权重，便于比较；导出仅用于提示文案）。 */
export { RISK_RANK };
/**
 * 把命令包进 markdown 围栏代码块。命令内含 3 个反引号时升级为 4 反引号围栏，
 * 保证内容不被误当作围栏结束符。
 */
export function codeFence(command) {
    const fence = command.includes("```") ? "````" : "```";
    return `${fence}\n${command}\n${fence}`;
}
/**
 * 组装"用户确认卡片"的 detail（markdown）。
 */
export function buildAskDetail(options) {
    const { command, toolName, mode, ruleLabel, ruleHint, reason, agentReview } = options;
    const lines = [];
    lines.push(`**Agent 请求执行以下命令**（工具：\`${toolName ?? "shell"}\`）`);
    lines.push("");
    lines.push(codeFence(command));
    lines.push("");
    lines.push("**命令说明**");
    if (mode === "rules") {
        if (ruleLabel)
            lines.push(`- 命中风险：${ruleLabel}`);
        if (ruleHint)
            lines.push(`- 提示：${ruleHint}`);
    }
    else if (agentReview) {
        const risk = agentReview.risk;
        const riskZh = risk && RISK_ZH[risk] ? RISK_ZH[risk] : "未知";
        lines.push(`- 判定来源：Agent 自审（档位 ${mode.replace(/^agent-/, "")}）`);
        if (risk)
            lines.push(`- 风险等级：${risk}（${riskZh}）`);
        if (agentReview.purpose)
            lines.push(`- 命令用途：${agentReview.purpose}`);
        if (agentReview.impact)
            lines.push(`- 可能影响：${agentReview.impact}`);
    }
    if (reason) {
        lines.push("");
        lines.push(reason);
    }
    lines.push("");
    lines.push("> 允许后本次调用才会执行；拒绝后 agent 会收到提示并可调整命令。");
    return lines.join("\n");
}
/**
 * 组装给 agent / 日志的简短原因（不含完整命令，避免刷屏）。
 */
export function buildShortReason(options) {
    const { mode, ruleLabel, ruleHint, reason, agentReview } = options;
    const parts = [];
    if (mode === "rules") {
        parts.push(ruleLabel ?? "命中风险规则");
        if (ruleHint)
            parts.push(ruleHint);
    }
    else if (agentReview) {
        const risk = agentReview.risk ? `${agentReview.risk}风险` : "风险";
        parts.push(`Agent 判定该命令存在${risk}`);
        if (agentReview.purpose)
            parts.push(`用途：${agentReview.purpose}`);
        if (agentReview.impact)
            parts.push(`影响：${agentReview.impact}`);
    }
    if (reason)
        parts.push(reason);
    return parts.join("；");
}
/**
 * 组装"用户拒绝/确认不可用"后返回给 agent 的 deny 原因。
 */
export function buildDenyReason(options) {
    const { command, reason, byUser = false } = options;
    const prefix = byUser ? "命令审核被用户拒绝" : "命令审核未能获得确认";
    const tail = command ? `。命令：${JSON.stringify(command)}` : "";
    return `${prefix}：${reason}${tail}`;
}
