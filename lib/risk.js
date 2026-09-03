// 命令风险决策引擎（纯函数，不依赖 cordis，可独立测试）。
import { LEVEL_RANK } from "./rules.js";
/**
 * 把配置中的字符串正则编译为 RegExp。
 * 编译失败（非法正则）时跳过并返回 null，避免一条坏规则拖垮整个插件。
 */
export function compilePattern(pattern) {
    try {
        return new RegExp(pattern, "i");
    }
    catch {
        return null;
    }
}
/** 编译一组字符串正则，过滤掉非法项。 */
export function compilePatterns(patterns) {
    return (patterns ?? [])
        .map((pattern) => (typeof pattern === "string" ? compilePattern(pattern) : null))
        .filter((regex) => regex !== null);
}
/**
 * 编译规则列表：把字符串 pattern 转成 RegExp。
 * 每条规则还会被冻结，避免运行期意外修改。
 */
export function compileRules(rules) {
    const compiled = [];
    for (const rule of rules ?? []) {
        if (typeof rule?.pattern !== "string")
            continue;
        const regex = compilePattern(rule.pattern);
        if (regex === null)
            continue;
        compiled.push(Object.freeze({ ...rule, pattern: regex }));
    }
    return compiled;
}
/** 命中一条命令的所有规则，按级别降序、规则顺序稳定。 */
export function matchRules(command, rules) {
    const hits = [];
    for (const rule of rules) {
        try {
            rule.pattern.lastIndex = 0;
            if (rule.pattern.test(command))
                hits.push(rule);
        }
        catch {
            // 单个规则执行异常不影响整体审核
        }
    }
    hits.sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level]);
    return hits;
}
/** 规则 → 人类可读的描述（用于 ask/deny 的 reason）。 */
export function describeRule(rule) {
    if (!rule)
        return "命中风险规则";
    const base = rule.description ?? `命中风险规则 ${rule.id}`;
    return rule.hint ? `${base}（${rule.hint}）` : base;
}
/**
 * 对一条命令做出审核决策。
 *
 * 优先级（从高到低）：
 *   1. 命中 critical 级别规则且达到 denyMinLevel → deny
 *   2. 命中 high 级别规则且达到 askMinLevel  → ask
 *   3. 命中白名单                                  → allow（allowlist）
 *   4. 命中 medium/low 规则，按 askMinLevel / denyMinLevel 决策
 *   5. 未命中任何规则 → LLM 决策（若有）否则 allow（default）
 */
export function decideCommand(command, options) {
    const { rules = [], allowPatterns = [], askMinLevel = "high", denyMinLevel = "critical", llmDecision, } = options;
    const hits = matchRules(command, rules);
    const top = hits[0];
    if (top !== undefined) {
        const rank = LEVEL_RANK[top.level];
        if (rank >= LEVEL_RANK[denyMinLevel]) {
            return {
                kind: "deny",
                level: top.level,
                source: "rules",
                rule: top,
                reason: describeRule(top),
            };
        }
        if (rank >= LEVEL_RANK[askMinLevel]) {
            return {
                kind: "ask",
                level: top.level,
                source: "rules",
                rule: top,
                reason: describeRule(top),
            };
        }
        // medium/low：未达阈值，正常放行
        return { kind: "allow", level: top.level, source: "rules", rule: top };
    }
    // 未命中规则：白名单次之（白名单优先级低于 high/critical，避免“ls 开头”的删除被放行）
    if (allowPatterns.some((regex) => {
        regex.lastIndex = 0;
        return regex.test(command);
    })) {
        return { kind: "allow", level: "low", source: "allowlist" };
    }
    if (llmDecision !== undefined && typeof llmDecision.kind === "string") {
        const kind = llmDecision.kind === "deny" || llmDecision.kind === "ask" || llmDecision.kind === "allow"
            ? llmDecision.kind
            : "allow";
        const reason = typeof llmDecision.reason === "string" ? llmDecision.reason : "";
        return {
            kind,
            level: kind === "deny" ? "high" : kind === "ask" ? "medium" : "low",
            source: "llm",
            reason: reason || "LLM 审核未通过",
        };
    }
    return { kind: "allow", level: "low", source: "default" };
}
/** 截断命令预览，避免超长命令淹没提示。 */
export function previewCommand(command, maxBytes = 300) {
    if (command.length <= maxBytes)
        return command;
    const cut = command.slice(0, Math.max(0, maxBytes - 1));
    return `${cut}…`;
}
