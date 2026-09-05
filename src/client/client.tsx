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
import * as React from "react";

// ---- 运行时平台 seed（构建时保留为外部 require；值经 import React 提供）----
declare const require: (spec: string) => any;

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

function injectStyle(tagId: string, css: string): void {
  if (typeof document === "undefined") return;
  if (document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) !== null) return;
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
function labelOf(modeId: string): string {
  return GUARD_MODES.find((entry) => entry.id === modeId)?.label ?? modeId;
}
// 档位 → 图标状态：颜色（按阈值由浅到深）+ 符号（rules 用字母，agent 档用点数 1–4）。
const MODE_ICON: Record<string, { color: string; dotCount: number; letter?: string }> = {
  rules: { color: "#8ab4f8", dotCount: 0, letter: "R" },
  "agent-very-loose": { color: "#7fd4a0", dotCount: 1 },
  "agent-loose": { color: "#f2c14e", dotCount: 2 },
  "agent-standard": { color: "#f39a4b", dotCount: 3 },
  "agent-strict": { color: "#e0574f", dotCount: 4 },
};
/** 盾形守卫图标（仅图标按钮与弹层条目共用）。 */
function ShieldIcon({ mode }: { mode: string }) {
  const conf = MODE_ICON[mode] ?? MODE_ICON.rules;
  const dots = [];
  for (let i = 0; i < conf.dotCount; i += 1) dots.push(i);
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 1.2L13.8 3v4.1c0 3.9-2.3 6.7-5.8 7.8C4.5 13.8 2.2 11 2.2 7.1V3z" fill={conf.color} />
      {conf.letter !== undefined ? (
        <text x="8" y="11" textAnchor="middle" fontSize="7" fontWeight="700" fill="#0b1220" style={{ userSelect: "none" }}>
          {conf.letter}
        </text>
      ) : (
        dots.map((i) => (
          <circle key={i} cx={8 - (conf.dotCount - 1) * 1.7 + i * 3.4} cy="8.6" r="1.1" fill="#0b1220" />
        ))
      )}
    </svg>
  );
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

// ---------------------------------------------------------------
// pending question 判定：PendingQuestion 类为官方 bundle 私有，这里鸭子类型。
// ---------------------------------------------------------------
interface PendingLike {
  key: string;
  questions?: { id: string; intent?: { kind: string; approve?: string }; detail?: string; options?: { label: string; description?: string }[] }[];
  answer(answer: unknown): unknown;
}
function isGuardReview(pending: unknown): pending is PendingLike {
  if (typeof pending !== "object" || pending === null) return false;
  const q = (pending as PendingLike).questions?.[0];
  return q !== undefined && q.intent?.kind === "guard-review";
}

// ---------------------------------------------------------------
// 确认卡：props.matched = composer 槽选中的 pending question。
// detail 用纯文本 <pre>（避免 Markdown 组件在槽内渲染引入的不确定性）。
// ---------------------------------------------------------------
function GuardApprovalCard(props: { matched?: PendingLike }) {
  const pending = props.matched;
  const question = pending?.questions?.[0];
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  if (!pending || !question) return null;
  const approveLabel = question.intent?.approve ?? LOC.allow;
  const denyLabel = question.options?.find((option) => option.label !== approveLabel)?.label ?? LOC.reject;
  const hasNote = note.trim().length > 0;
  const commit = (label: string, custom?: string): void => {
    if (busy) return;
    setBusy(true);
    // harness 单选约定：custom 与 selected 互斥；提交（拒绝 + 留言）只带 custom。
    const answers = [{ id: question.id, ...(custom !== undefined ? { selected: [], custom } : { selected: [label] }) }];
    Promise.resolve()
      .then(() => pending.answer({ answers }))
      .catch(() => setBusy(false));
  };
  return (
    <div className="cga_root" data-guard-approval-key={pending.key}>
      <div className="cga_card">
        <div className="cga_strip">
          <span className="cga_dot" />
          {LOC.waiting}
        </div>
        <div className="cga_body" tabIndex={0} role="group" aria-label={LOC.aria}>
          {question.detail ? (
            <pre className="cga_meta">{question.detail}</pre>
          ) : (
            <div className="cga_meta">{LOC.headline}</div>
          )}
        </div>
        <div className="cga_actionRow">
          <input
            className="cga_input"
            value={note}
            disabled={busy}
            placeholder={LOC.placeholder}
            aria-label={LOC.placeholder}
            onChange={(event) => setNote(event.currentTarget.value)}
          />
          <button type="button" className="cga_btn cga_btnReject" disabled={busy} onClick={() => commit(denyLabel, hasNote ? note.trim() : undefined)}>
            {hasNote ? LOC.submit : LOC.reject}
          </button>
          <button type="button" className="cga_btn cga_btnPrimary" disabled={busy} onClick={() => commit(approveLabel)}>
            {LOC.allow}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------
// 输入区"命令审核"按钮 + 档位下拉。槽位 occupant 的 inject(sessionId) 回调会收到
// 当前会话 id；组件只依赖注入面（guardApi 已把 sessionId 闭包绑定）。
// ---------------------------------------------------------------
interface GuardZoneApi {
  current(): Promise<string | null>;
  switchMode(modeId: string): Promise<string>;
}
/**
 * 输入区"命令审核"按钮（样式与旧版一致）：圆形"仅图标"按钮（与"+"号同款），
 * 用盾形图标的颜色/符号区分档位；点击后弹层**向上**展开，外部点击关闭。
 * 槽位 occupant 的 inject(sessionId) 回调会收到当前会话 id，guardApi 已闭包绑定。
 */
function GuardZone(props: { guardApi?: GuardZoneApi }) {
  const api = props.guardApi;
  const [current, setCurrent] = React.useState<string | null>(null);
  const [open, setOpen] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const hostRef = React.useRef<HTMLSpanElement | null>(null);

  // 初始：读当前会话档位。
  React.useEffect(() => {
    if (!api || typeof api.current !== "function") return;
    let alive = true;
    api
      .current()
      .then((value) => {
        if (alive && typeof value === "string") setCurrent(value);
      })
      .catch(() => {
        /* host 未提供 /guard 时保持默认 */
      });
    return () => {
      alive = false;
    };
  }, [api]);

  // 点击外部关闭向上弹层。
  React.useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (hostRef.current && !hostRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  if (!api) return null;
  const currentLabel = current === null ? null : labelOf(current);
  const pick = (id: string): void => {
    setOpen(false);
    if (typeof api.switchMode !== "function") return;
    api
      .switchMode(id)
      .then(() => {
        setCurrent(id);
        setError(null);
      })
      .catch((cause: unknown) => {
        const message = cause instanceof Error ? cause.message : String(cause);
        setError(`切换档位失败：${message}`);
        setOpen(true);
      });
  };
  return (
    <span ref={hostRef} style={{ position: "relative", display: "inline-flex", alignItems: "center" }}>
      {error !== null && (
        <span className="cgZn_error" title={error} aria-label={error}>
          !
        </span>
      )}
      <button
        type="button"
        className="cgZn_selector"
        aria-haspopup="menu"
        aria-expanded={open}
        title={error ?? (currentLabel ? `${LOC.waiting}（当前：${currentLabel}）` : LOC.waiting)}
        onClick={() => setOpen((value) => !value)}
      >
        <ShieldIcon mode={current ?? "rules"} />
      </button>
      {open && (
        <div
          role="menu"
          className="cgZn_popover"
          style={{ position: "absolute", bottom: "calc(100% + 6px)", left: "0", minWidth: "200px", maxHeight: "min(320px, 60vh)", overflowY: "auto" }}
        >
          {GUARD_MODES.map((option) => {
            const active = option.id === current;
            return (
              <div
                key={option.id}
                role="menuitem"
                className={active ? "cgZn_popoverActive" : undefined}
                style={{ fontSize: 13, lineHeight: "20px", padding: "8px 12px", cursor: "pointer" }}
                title={option.detail}
                onClick={() => pick(option.id)}
              >
                <ShieldIcon mode={option.id} />
                <span style={{ marginLeft: 8 }}>{option.label}</span>
              </div>
            );
          })}
        </div>
      )}
    </span>
  );
}

// ---------------------------------------------------------------
// 客户端插件主体。
// ---------------------------------------------------------------
export const inject = ["slots", "sessions", "commandUi"];
export function apply(ctx: any): void {
  injectStyle(STYLE_ID, CARD_CSS);
  injectStyle(ZONE_STYLE_ID, ZONE_CSS);
  const sessions = ctx.sessions;
  const command = ctx.get("commandUi");

  const liveOf = (sessionId: string): any => {
    const binding = sessions.binding(sessionId);
    return binding === undefined ? undefined : binding.session;
  };
  const guardCurrent = (sessionId: string | undefined): Promise<string | null> => {
    if (sessionId === undefined) return Promise.resolve(null);
    const live = liveOf(sessionId);
    if (live === undefined) return Promise.resolve(null);
    return live
      .command("/guard")
      .then((result: any) =>
        result?.ok === true && result.value?.matched === true && typeof result.value.text === "string" ? result.value.text : null,
      )
      .catch(() => null);
  };
  const guardSwitch = (sessionId: string, modeId: string): Promise<string> => {
    const live = liveOf(sessionId);
    if (live === undefined) return Promise.reject(new Error("session not materialized"));
    return live.command(`/guard ${modeId}`).then((result: any) => {
      if (!result?.ok) throw new Error("guard switch failed: " + (result?.error?.message ?? "unknown"));
      return result.value?.matched === true ? result.value.text : modeId;
    });
  };

  // 1) 确认卡：composer 槽位接管 guard-review。
  ctx.slots.inject("conversation.composer", () =>
    ctx.slots.register(
      {
        name: "conversation.composer",
        // 低 priority：先于官方通用提问被询问；仅接管 guard-review，
        // 其它 pending（普通问询/plan-review）返回 null 交还官方渲染。
        priority: -20,
        select: (face: any): PendingLike | null => {
          const pending = face?.pendingInteraction !== undefined ? face.pendingInteraction : face;
          return isGuardReview(pending) ? pending : null;
        },
      },
      GuardApprovalCard,
    ),
  );

  // 2) 输入区"命令审核"按钮。槽位 occupant 的 inject 会收到当前 sessionId；
  //    用它闭包出 guardApi，组件不依赖 props.session。
  try {
    ctx.slots.inject("conversation.input.left", () =>
      ctx.slots.register(
        {
          name: "conversation.input.left",
          id: "command-guard-zone",
          order: 0,
          inject: (sessionId: string): { guardApi: GuardZoneApi } => ({
            guardApi: {
              current: () => guardCurrent(sessionId),
              switchMode: (modeId: string) => guardSwitch(sessionId, modeId),
            },
          }),
        },
        GuardZone,
      ),
    );
  } catch (error) {
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
          options: (session: any) => {
            const sessionId = session?.sessionId;
            return guardCurrent(sessionId).then((current) =>
              GUARD_MODES.map((entry) => ({ id: entry.id, label: entry.label, ...(entry.id === current ? { active: true } : {}) })),
            );
          },
          onSelect: (option: any, session: any) => {
            const sessionId = session?.sessionId;
            if (sessionId === undefined) throw new Error("this session is not materialized yet");
            return guardSwitch(sessionId, option.id).then(() => undefined);
          },
        },
      });
    }
  } catch (error) {
    console.warn("[dsh-command-guard] /guard decoration unavailable:", error);
  }
}
