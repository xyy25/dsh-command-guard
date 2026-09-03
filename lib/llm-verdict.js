// LLM 审核的纯函数部分：无外部依赖，便于单元测试与复用。
/** 风险等级集合（agent 自审输出）。 */
export const AGENT_RISKS = ["safe", "low", "medium", "high", "critical"];
/** 档位后缀 → 中文说明（用于 agent prompt 中解释当前档位期望）。 */
const THRESHOLD_HINT_ZH = Object.freeze({
    "very-loose": "极其宽松：只对明确不可逆、近乎不可能合法的命令（如删除根目录、格式化磁盘）要求确认。",
    loose: "宽松：只对明显破坏性、有不可逆副作用的高危命令要求确认。",
    standard: "标准：对有数据丢失、系统级改动、远程执行等副作用的中危及以上命令要求确认。",
    strict: "严格：只要不是明显安全（纯只读/查询/常规构建）都要求确认。",
});
/** 由档位后缀（very-loose/loose/standard/strict）得到中文阈值说明。 */
export function thresholdHintZh(tier) {
    return THRESHOLD_HINT_ZH[tier] ?? THRESHOLD_HINT_ZH.standard;
}
/**
 * 构造"agent 自审"提示词：模型需要像即将执行命令的 agent 一样，
 * 判断命令风险，并简明说明用途与影响（将展示给用户）。
 * @param command 待审核命令
 * @param toolName 工具名（pwsh/bash）
 * @param tier 档位后缀：very-loose | loose | standard | strict
 */
export function buildAgentReviewPrompt(command, toolName, tier) {
    return [
        "你是将要执行下面这条命令的 agent。在真正执行前，你需要先审核它并汇报给用户确认。",
        `执行工具：\`${toolName}\`。`,
        "",
        "请按以下风险等级判断（只选一个）：",
        "- safe —— 明显安全：只读、查询、显示信息、常规构建/安装到当前项目等，无显著副作用。",
        "- low —— 轻微副作用：如修改当前项目内的非关键文件、安装本地依赖、临时文件操作等。",
        "- medium —— 有副作用：删除/覆盖文件或目录、修改配置或权限、停止进程/服务、容器操作等，意图可能合法但影响需要用户知情。",
        "- high —— 明显破坏性：递归强制删除、清空内容、破坏性 git/数据库操作、系统级改动、下载并执行脚本等。",
        "- critical —— 几乎不可能是合法意图：删除根目录、格式化磁盘、关闭安全防护等。",
        "",
        `当前确认阈值：${thresholdHintZh(tier)}`,
        "",
        `命令：\`\`\`\n${command}\n\`\`\``,
        "",
        '输出 JSON：{"risk":"safe"|"low"|"medium"|"high"|"critical","purpose":"用一句话说明这条命令的用途","impact":"用一句话说明可能造成的影响"}',
        "",
        "purpose 与 impact 必须简明（一句话），随后会原样展示给用户确认。",
    ].join("\n");
}
/**
 * 从模型输出解析 agent 自审结果。
 * 兼容旧的 allow/ask/deny 短响应（映射为风险等级），便于旧模型直接切换。
 * @param text 模型输出
 * @returns 解析结果；无法解析时返回 undefined
 */
export function parseAgentReview(text) {
    const trimmed = (text ?? "").trim();
    if (!trimmed)
        return undefined;
    try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === "object") {
            const risk = typeof parsed.risk === "string" ? parsed.risk.toLowerCase() : "";
            const purpose = typeof parsed.purpose === "string" ? parsed.purpose.trim() : "";
            const impact = typeof parsed.impact === "string" ? parsed.impact.trim() : "";
            if (AGENT_RISKS.includes(risk)) {
                return { risk, purpose, impact: impact || purpose };
            }
            // 旧 verdict 格式兼容
            const verdict = typeof parsed.verdict === "string" ? parsed.verdict.toLowerCase() : "";
            const reason = typeof parsed.reason === "string" ? parsed.reason.trim() : "";
            if (verdict === "allow")
                return { risk: "safe", purpose: reason, impact: "" };
            if (verdict === "ask")
                return { risk: "medium", purpose: reason, impact: "可能需要用户确认后执行" };
            if (verdict === "deny")
                return { risk: "critical", purpose: reason, impact: "模型判定该命令风险过高" };
        }
    }
    catch {
        // 模型没有输出合法 JSON，走关键词扫描
    }
    const lower = trimmed.toLowerCase();
    if (/\bcritical\b/.test(lower))
        return { risk: "critical", purpose: "", impact: "" };
    if (/\bhigh\b/.test(lower) || (/\bdeny\b/.test(lower) && !/\ballow\b/.test(lower))) {
        return { risk: "high", purpose: "", impact: "" };
    }
    if (/\bmedium\b/.test(lower) || /\bask\b/.test(lower))
        return { risk: "medium", purpose: "", impact: "" };
    if (/\b(?:low|risk)\b/.test(lower))
        return { risk: "low", purpose: "", impact: "" };
    if (/\bsafe\b/.test(lower) || /\ballow\b/.test(lower))
        return { risk: "safe", purpose: "", impact: "" };
    return undefined;
}
/**
 * 构造"规则兜底"（旧版）审核 prompt。
 */
export function buildReviewPrompt(command, toolName) {
    return [
        `请判断以下通过 \`${toolName}\` 工具执行的命令是否高风险。`,
        "高风险包括：删除/覆盖数据、格式化磁盘、修改权限或账户、关闭安全防护、下载并执行远程脚本、改写 git 历史、无 WHERE 的数据库写操作等。",
        "若命令明显无害（只读、查询、常规构建/安装到当前项目），判定为 allow。",
        "若命令有破坏性或不可逆副作用、但可能是合法意图，判定为 ask（需要用户确认）。",
        "若命令几乎不可能是合法意图（删除根目录、关闭杀毒、格式化磁盘等），判定为 deny。",
        "",
        `命令：\`\`\`\n${command}\n\`\`\``,
        "",
        '输出 JSON：{"verdict":"allow"|"ask"|"deny","reason":"一句话中文理由"}',
    ].join("\n");
}
/** 从模型输出中解析 verdict（旧版）。 */
export function parseVerdict(text) {
    const trimmed = (text ?? "").trim();
    try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === "object") {
            const kind = typeof parsed.verdict === "string" ? parsed.verdict.toLowerCase() : "";
            const reason = typeof parsed.reason === "string" ? parsed.reason : "";
            if (kind === "allow" || kind === "ask" || kind === "deny") {
                return { kind, reason };
            }
        }
    }
    catch {
        // 模型没有输出合法 JSON，走关键词扫描
    }
    const lower = trimmed.toLowerCase();
    if (/\bdeny\b/.test(lower) && !/\ballow\b/.test(lower))
        return { kind: "deny", reason: "LLM 判定为拒绝" };
    if (/\bask\b/.test(lower))
        return { kind: "ask", reason: "LLM 判定需要确认" };
    if (/\ballow\b/.test(lower))
        return { kind: "allow", reason: "LLM 判定安全" };
    return undefined;
}
