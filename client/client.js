// 由 src/client/client.tsx 经 npm run build 构建生成，请勿手改；源码修改后重新构建。
window.__ModuleLoader__.load({
	id: "dsh-command-guard",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.inject = void 0;
exports.apply = apply;
// dsh-command-guard 客户端 UI 源码（dsh v0.1.2+ 适配版）。
//
// 说明：
//   - 本文件是唯一客户端源码；产物 client/client.js 由 `npm run build`
//     （tsc -p src/client/tsconfig.json → build/bundle-client.mjs）生成。
//   - dsh v0.1.2 起客户端为 "module table + 平台 seed" 机制：本插件 client 只能
//     require 平台 seed（react、@deepseek-ai/dsh-client-ui-primitives），并依赖
//     客户端 cordis 服务（slots/sessions/commandUi）。构建机需安装 seed devDeps
//     （react、@types/react、@deepseek-ai/dsh-client-ui-primitives）。
//   - 功能：
//     1) conversation.composer：接管 intent.kind === "guard-review" 的 pending，
//        渲染自绘确认卡（一次点击允许/拒绝；输入框有内容时拒绝变"提交"，文本以
//        selected:[] + custom 回传——harness 单选约定 custom 与 selected 互斥）。
//     2) conversation.input.left：输入区"命令审核"按钮（当前会话档位下拉）。
//     3) commandUi：/guard 命令装饰（输入 /guard 时弹出档位选择）。
const React = __importStar(require("react"));
// ---------------------------------------------------------------
// 样式：确认卡与输入区按钮（字符串注入 <style>）。
// ---------------------------------------------------------------
const STYLE_ID = "dsh-command-guard/GuardCard.module.css";
const CARD_CSS = [
    ".cga_root{padding:8px calc(var(--dsh-composer-side-clearance,16px)+12px) 12px;flex-direction:column;align-items:center;display:flex}",
    ".cga_card{width:100%;max-width:var(--dsh-chat-content-width,760px);border:1px solid var(--dsw-alias-state-warn-secondary);background:var(--dsw-specific-input-major);border-radius:20px;overflow:hidden}",
    ".cga_strip{background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-state-warn-primary);align-items:center;gap:8px;padding:10px 16px;font-size:13px;line-height:18px;display:flex}",
    ".cga_dot{background:var(--dsw-alias-state-warn-primary);border-radius:50%;width:8px;height:8px}",
    ".cga_body{max-height:240px;flex-direction:column;gap:6px;padding:12px 16px 0;display:flex;overflow:auto}",
    ".cga_meta{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;white-space:pre-wrap}",
    ".cga_actionRow{justify-content:flex-end;align-items:center;gap:8px;padding:14px 16px;display:flex}",
    ".cga_input{flex:1;min-width:0;height:34px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;padding:0 10px}",
    ".cga_input:focus{outline:none;border-color:var(--dsw-alias-interactive-accent)}",
    ".cga_btn{height:34px;border:1px solid var(--dsw-alias-border-l2);border-radius:18px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;padding:0 14px;cursor:pointer;flex:none}",
    ".cga_btnPrimary{background:var(--dsw-alias-interactive-accent);border-color:var(--dsw-alias-interactive-accent);color:var(--dsw-alias-label-on-accent)}",
    ".cga_btn:disabled{opacity:.55;cursor:default}",
    ".cga_btnReject:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);border-color:transparent}",
].join("");
const ZONE_STYLE_ID = "dsh-command-guard/GuardZone.module.css";
// 样式与旧版（v0.1.1）一致：圆形"仅图标"按钮 + 向上弹层 + 错误标记。
const ZONE_CSS = [
    ".cgZn_selector{background:var(--dsw-alias-bg-module-platform);width:28px;height:28px;font:inherit;color:var(--dsw-alias-label-primary);cursor:pointer;border:none;border-radius:14px;align-items:center;justify-content:center;gap:0;padding:0;font-size:13px;line-height:20px;display:inline-flex}",
    ".cgZn_selector:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
    ".cgZn_selector:disabled{cursor:default}.cgZn_chevron{flex:none}",
    ".cgZn_error{color:var(--dsw-alias-state-error-primary);font-weight:700;margin-right:4px}",
    ".cgZn_popover{background:var(--dsw-specific-input-major);border:1px solid var(--dsw-alias-border-l2-darkmode-thin);border-radius:12px;box-shadow:var(--dsw-shadow-lv2);color:var(--dsw-alias-label-primary);padding:6px;z-index:1200}",
    ".cgZn_popover [role=menuitem]:hover{background:var(--dsw-alias-interactive-bg-hover)}",
    ".cgZn_popoverActive{background:var(--dsw-alias-interactive-bg-hover);font-weight:600}",
].join("");
function injectStyle(tagId, css) {
    if (typeof document === "undefined")
        return;
    if (document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) !== null)
        return;
    const tag = document.createElement("style");
    tag.dataset.plugin = "dsh-command-guard";
    tag.dataset.pluginCss = tagId;
    tag.textContent = css;
    document.head.appendChild(tag);
}
// ---------------------------------------------------------------
// 档位镜像（与 lib/modes.ts 一致；client 独立产物不能 import host 模块）。
// detail 用于弹层条目的悬浮说明；MODE_ICON 描述"仅图标"按钮的盾形样式。
// ---------------------------------------------------------------
const GUARD_MODES = [
    { id: "rules", label: "硬规则判定", detail: "规则引擎按配置自动判定；命中即向你确认" },
    { id: "agent-very-loose", label: "Agent 判定 · 极宽松", detail: "仅当 agent 判定为 critical（不可逆破坏）时才确认" },
    { id: "agent-loose", label: "Agent 判定 · 宽松", detail: "agent 判定为 high 及以上（明显破坏性）时确认" },
    { id: "agent-standard", label: "Agent 判定 · 标准", detail: "agent 判定为 medium 及以上（有副作用）时确认" },
    { id: "agent-strict", label: "Agent 判定 · 严格", detail: "agent 判定为 low 及以上（存疑即确认），仅明显安全的命令放行" },
];
function labelOf(modeId) {
    return GUARD_MODES.find((entry) => entry.id === modeId)?.label ?? modeId;
}
// 档位 → 图标状态：颜色（按阈值由浅到深）+ 符号（rules 用字母，agent 档用点数 1–4）。
const MODE_ICON = {
    rules: { color: "#8ab4f8", dotCount: 0, letter: "R" },
    "agent-very-loose": { color: "#7fd4a0", dotCount: 1 },
    "agent-loose": { color: "#f2c14e", dotCount: 2 },
    "agent-standard": { color: "#f39a4b", dotCount: 3 },
    "agent-strict": { color: "#e0574f", dotCount: 4 },
};
/** 盾形守卫图标（仅图标按钮与弹层条目共用）。 */
function ShieldIcon({ mode }) {
    const conf = MODE_ICON[mode] ?? MODE_ICON.rules;
    const dots = [];
    for (let i = 0; i < conf.dotCount; i += 1)
        dots.push(i);
    return (React.createElement("svg", { width: "15", height: "15", viewBox: "0 0 16 16", "aria-hidden": "true" },
        React.createElement("path", { d: "M8 1.2L13.8 3v4.1c0 3.9-2.3 6.7-5.8 7.8C4.5 13.8 2.2 11 2.2 7.1V3z", fill: conf.color }),
        conf.letter !== undefined ? (React.createElement("text", { x: "8", y: "11", textAnchor: "middle", fontSize: "7", fontWeight: "700", fill: "#0b1220", style: { userSelect: "none" } }, conf.letter)) : (dots.map((i) => (React.createElement("circle", { key: i, cx: 8 - (conf.dotCount - 1) * 1.7 + i * 3.4, cy: "8.6", r: "1.1", fill: "#0b1220" }))))));
}
// ---------------------------------------------------------------
// 文案（内置简体中文；不依赖 locale 注册）。
// ---------------------------------------------------------------
const LOC = {
    waiting: "命令审核",
    headline: "Agent 请求执行一条被判定为有风险的命令，是否允许执行？",
    placeholder: "如需告诉 Agent 怎么做，可在此输入（提交后随拒绝一并反馈）",
    submit: "提交",
    reject: "拒绝",
    allow: "允许执行",
    aria: "命令审核详情",
    zoneHint: "命令审核档位（当前会话）",
};
function isGuardReview(pending) {
    if (typeof pending !== "object" || pending === null)
        return false;
    const q = pending.questions?.[0];
    return q !== undefined && q.intent?.kind === "guard-review";
}
// ---------------------------------------------------------------
// 确认卡：props.matched = composer 槽选中的 pending question。
// detail 用纯文本 <pre>（避免 Markdown 组件在槽内渲染引入的不确定性）。
// ---------------------------------------------------------------
function GuardApprovalCard(props) {
    const pending = props.matched;
    const question = pending?.questions?.[0];
    const [note, setNote] = React.useState("");
    const [busy, setBusy] = React.useState(false);
    if (!pending || !question)
        return null;
    const approveLabel = question.intent?.approve ?? LOC.allow;
    const denyLabel = question.options?.find((option) => option.label !== approveLabel)?.label ?? LOC.reject;
    const hasNote = note.trim().length > 0;
    const commit = (label, custom) => {
        if (busy)
            return;
        setBusy(true);
        // harness 单选约定：custom 与 selected 互斥；提交（拒绝 + 留言）只带 custom。
        const answers = [{ id: question.id, ...(custom !== undefined ? { selected: [], custom } : { selected: [label] }) }];
        Promise.resolve()
            .then(() => pending.answer({ answers }))
            .catch(() => setBusy(false));
    };
    return (React.createElement("div", { className: "cga_root", "data-guard-approval-key": pending.key },
        React.createElement("div", { className: "cga_card" },
            React.createElement("div", { className: "cga_strip" },
                React.createElement("span", { className: "cga_dot" }),
                LOC.waiting),
            React.createElement("div", { className: "cga_body", tabIndex: 0, role: "group", "aria-label": LOC.aria }, question.detail ? (React.createElement("pre", { className: "cga_meta" }, question.detail)) : (React.createElement("div", { className: "cga_meta" }, LOC.headline))),
            React.createElement("div", { className: "cga_actionRow" },
                React.createElement("input", { className: "cga_input", value: note, disabled: busy, placeholder: LOC.placeholder, "aria-label": LOC.placeholder, onChange: (event) => setNote(event.currentTarget.value) }),
                React.createElement("button", { type: "button", className: "cga_btn cga_btnReject", disabled: busy, onClick: () => commit(denyLabel, hasNote ? note.trim() : undefined) }, hasNote ? LOC.submit : LOC.reject),
                React.createElement("button", { type: "button", className: "cga_btn cga_btnPrimary", disabled: busy, onClick: () => commit(approveLabel) }, LOC.allow)))));
}
/**
 * 输入区"命令审核"按钮（样式与旧版一致）：圆形"仅图标"按钮（与"+"号同款），
 * 用盾形图标的颜色/符号区分档位；点击后弹层**向上**展开，外部点击关闭。
 * 注意：初始档位只读 host settings（不执行任何命令），否则每次进入会话都会
 * 在会话里多出一条 `guard · …` 状态行。
 */
function GuardZone(props) {
    const api = props.guardApi;
    const [current, setCurrent] = React.useState(null);
    const [open, setOpen] = React.useState(false);
    const [error, setError] = React.useState(null);
    const hostRef = React.useRef(null);
    // 初始档位：读 settings 默认档（无副作用，可安全重复）。
    React.useEffect(() => {
        if (!api || typeof api.defaultMode !== "function")
            return;
        let alive = true;
        api
            .defaultMode()
            .then((value) => {
            if (alive && typeof value === "string")
                setCurrent(value);
        })
            .catch(() => {
            /* 读取失败时保持默认图标 */
        });
        return () => {
            alive = false;
        };
    }, [api, props.sessionId]);
    // 点击外部关闭向上弹层。
    React.useEffect(() => {
        if (!open)
            return;
        const onDown = (event) => {
            if (hostRef.current && !hostRef.current.contains(event.target))
                setOpen(false);
        };
        document.addEventListener("mousedown", onDown);
        return () => document.removeEventListener("mousedown", onDown);
    }, [open]);
    if (!api)
        return null;
    const currentLabel = current === null ? null : labelOf(current);
    const pick = (id) => {
        setOpen(false);
        if (typeof api.switchMode !== "function")
            return;
        api
            .switchMode(id)
            .then(() => {
            setCurrent(id);
            setError(null);
        })
            .catch((cause) => {
            const message = cause instanceof Error ? cause.message : String(cause);
            setError(`切换档位失败：${message}`);
            setOpen(true);
        });
    };
    return (React.createElement("span", { ref: hostRef, style: { position: "relative", display: "inline-flex", alignItems: "center" } },
        error !== null && (React.createElement("span", { className: "cgZn_error", title: error, "aria-label": error }, "!")),
        React.createElement("button", { type: "button", className: "cgZn_selector", "aria-haspopup": "menu", "aria-expanded": open, title: error ?? (currentLabel ? `${LOC.waiting}（当前：${currentLabel}）` : LOC.waiting), onClick: () => setOpen((value) => !value) },
            React.createElement(ShieldIcon, { mode: current ?? "rules" })),
        open && (React.createElement("div", { role: "menu", className: "cgZn_popover", style: { position: "absolute", bottom: "calc(100% + 6px)", left: "0", minWidth: "200px", maxHeight: "min(320px, 60vh)", overflowY: "auto" } }, GUARD_MODES.map((option) => {
            const active = option.id === current;
            return (React.createElement("div", { key: option.id, role: "menuitem", className: active ? "cgZn_popoverActive" : undefined, style: { fontSize: 13, lineHeight: "20px", padding: "8px 12px", cursor: "pointer" }, title: option.detail, onClick: () => pick(option.id) },
                React.createElement(ShieldIcon, { mode: option.id }),
                React.createElement("span", { style: { marginLeft: 8 } }, option.label)));
        })))));
}
// ---------------------------------------------------------------
// 客户端插件主体。
// ---------------------------------------------------------------
/** 默认档位可能所在的 settings namespace（按 dsh 版本从新到旧）。 */
const GUARD_SETTINGS_NS = ["command-guard", "commandGuard", "dsh-command-guard"];
exports.inject = ["slots", "sessions", "commandUi"];
function apply(ctx) {
    injectStyle(STYLE_ID, CARD_CSS);
    injectStyle(ZONE_STYLE_ID, ZONE_CSS);
    const sessions = ctx.sessions;
    const command = ctx.get("commandUi");
    // 设置读取源（可选服务）：dsh 0.2.0 起 settingsScope 被 configForms 取代，
    // 两者 describe() 的结构一致（mirror 有 ensure()/getSnapshot()）；0.1.x 仍是
    // settingsScope。都缺失时 zone 仅显示默认图标。
    const configForms = ctx.get("configForms");
    const settingsScope = ctx.get("settingsScope");
    const settingsFace = configForms ?? settingsScope;
    const liveOf = (sessionId) => {
        const binding = sessions.binding(sessionId);
        return binding === undefined ? undefined : binding.session;
    };
    /**
     * 读默认档位（无副作用）。
     *
     * namespace 随 dsh 版本变化：
     *   - 0.1.x：本插件自注册的 `commandGuard`；
     *   - 0.2.0+：settings 改为按插件 Config 自动派生，ns 即 profile patch 里的
     *     entry id（通常是 `command-guard`），值就是 config。
     * 因此按候选列表查找，最后回退到"任意 namespace 的 mode 恰好是合法档位"。
     *
     * 绝不要改成执行 `/guard` 来查询：命令会写入会话，导致每次进入会话多出
     * 一条 `guard · …` 状态行。
     */
    const readDefaultMode = async () => {
        try {
            const face = settingsFace?.describe?.();
            if (face === undefined)
                return null;
            if (typeof face.ensure === "function") {
                try {
                    await face.ensure();
                }
                catch {
                    /* 忽略：拿不到快照就保持默认 */
                }
            }
            const snapshot = typeof face.getSnapshot === "function" ? face.getSnapshot() : undefined;
            const namespaces = snapshot?.view?.namespaces;
            if (!Array.isArray(namespaces))
                return null;
            for (const ns of GUARD_SETTINGS_NS) {
                const entry = namespaces.find((item) => item?.ns === ns);
                const mode = entry?.value?.mode;
                if (typeof mode === "string")
                    return mode;
            }
            // 兜底：entry id 由用户自定（cordis.patch.yml 里可任意命名），
            // 用"值恰好是合法档位"来认领。
            const byValue = namespaces.find((item) => typeof item?.value?.mode === "string" && GUARD_MODES.some((m) => m.id === item.value.mode));
            return typeof byValue?.value?.mode === "string" ? byValue.value.mode : null;
        }
        catch {
            return null;
        }
    };
    const guardSwitch = (sessionId, modeId) => {
        const live = liveOf(sessionId);
        if (live === undefined)
            return Promise.reject(new Error("session not materialized"));
        return live.command(`/guard ${modeId}`).then((result) => {
            if (!result?.ok)
                throw new Error("guard switch failed: " + (result?.error?.message ?? "unknown"));
            return result.value?.matched === true ? result.value.text : modeId;
        });
    };
    // 1) 确认卡：composer 槽位接管 guard-review。
    ctx.slots.inject("conversation.composer", () => ctx.slots.register({
        name: "conversation.composer",
        // 低 priority：先于官方通用提问被询问；仅接管 guard-review，
        // 其它 pending（普通问询/plan-review）返回 null 交还官方渲染。
        priority: -20,
        select: (face) => {
            const pending = face?.pendingInteraction !== undefined ? face.pendingInteraction : face;
            return isGuardReview(pending) ? pending : null;
        },
    }, GuardApprovalCard));
    // 2) 输入区"命令审核"按钮。槽位 occupant 的 inject 会收到当前 sessionId；
    //    用它闭包出 guardApi，组件不依赖 props.session。
    try {
        ctx.slots.inject("conversation.input.left", () => ctx.slots.register({
            name: "conversation.input.left",
            id: "command-guard-zone",
            order: 0,
            inject: (sessionId) => ({
                sessionId,
                guardApi: {
                    defaultMode: readDefaultMode,
                    switchMode: (modeId) => guardSwitch(sessionId, modeId),
                },
            }),
        }, GuardZone));
    }
    catch (error) {
        console.warn("[dsh-command-guard] input-zone unavailable:", error);
    }
    // 3) /guard 命令装饰（输入 /guard 时弹出档位选择）。
    try {
        if (command !== undefined && typeof command.decorate === "function") {
            command.decorate({
                name: "guard",
                available: () => true,
                ui: {
                    kind: "popupSelect",
                    options: (session) => {
                        // 仅读 settings 默认档标 active（不执行命令，避免写入会话状态行）。
                        void session;
                        return readDefaultMode().then((current) => GUARD_MODES.map((entry) => ({ id: entry.id, label: entry.label, ...(entry.id === current ? { active: true } : {}) })));
                    },
                    onSelect: (option, session) => {
                        const sessionId = session?.sessionId;
                        if (sessionId === undefined)
                            throw new Error("this session is not materialized yet");
                        return guardSwitch(sessionId, option.id).then(() => undefined);
                    },
                },
            });
        }
    }
    catch (error) {
        console.warn("[dsh-command-guard] /guard decoration unavailable:", error);
    }
}
		return module.exports;
	}
});
