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
  ".cga_md{color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}",
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
// detail 的 Markdown 渲染：富文本优先、纯文本保底。
//
// 为什么以前用 <pre>：v0.1.2 时直接渲染 MarkdownText 会让整个 composer 槽崩溃。
// 根因不是"槽不支持 Markdown"，而是 MarkdownText 的 labels 是**必需**参数
// （内部直接读 context.labels.code.*，没有可选链）——不传就抛 TypeError。
// dsh 0.2.0 的官方提问卡就在同一个槽里用 MarkdownText 渲染 question.detail，
// 并传入 labels。
//
// 因此这里：
//   1) 仅在 configForms 服务存在（dsh 0.2.0+）时启用 Markdown；
//   2) 传齐必需 labels；
//   3) 用错误边界兜底：一旦渲染失败立即退回 <pre>，输入区不受影响。
// ---------------------------------------------------------------
const primitivesRuntime: any = typeof require === "function" ? require("@deepseek-ai/dsh-client-ui-primitives") : undefined;
const MarkdownText: any = primitivesRuntime?.MarkdownText;
/** dsh 0.2.0+ 才启用（旧版 labels 契约未验证，保持 <pre>）。 */
let markdownEnabled = false;
/** 是否允许展开菜单时查询真实档位（来自配置 queryModeOnOpen，默认 true）。 */
let queryModeOnOpen = true;
/** typert 只读服务（host 注册 commandGuard 后由 api-gateway 自动提供 remote.commandGuard）。 */
let remoteGuard: { sessionMode(sessionId: string): Promise<any> } | undefined;
/** connection RPC 客户端（官方通道，零会话事件读取档位）。 */
let rpcClient: { call(channel: string, endpoint: string, payload: any, signal?: any): Promise<any> } | undefined;
/** MarkdownText 必需的 labels（缺 code 会抛 TypeError）。 */
const MD_LABELS = {
  code: {
    copyLabel: "复制",
    copiedLabel: "已复制",
    toolbarLabels: { codeLabel: "代码", wrapLabel: "自动换行", unwrapLabel: "取消换行" },
  },
  footnotes: "脚注",
};

/** 只包住 Markdown 子树的错误边界：渲染失败就回退到纯文本。 */
const MarkdownBoundary: any = class extends React.Component<{ fallback: any; children?: any }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  render(): any {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
};

// ---------------------------------------------------------------
// 确认卡：props.matched = composer 槽选中的 pending question。
// detail 在 0.2.0+ 用 Markdown 渲染；旧版或渲染失败时回退 <pre>。
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
            markdownEnabled && MarkdownText !== undefined ? (
              <MarkdownBoundary fallback={<pre className="cga_meta">{question.detail}</pre>}>
                <div className="cga_md">
                  <MarkdownText text={question.detail} labels={MD_LABELS} />
                </div>
              </MarkdownBoundary>
            ) : (
              <pre className="cga_meta">{question.detail}</pre>
            )
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
  /** 读 host settings 里的默认档位（无副作用：不执行 /guard，不写会话状态行）。 */
  defaultMode(): Promise<string | null>;
  /** 查询当前会话真实档位（走 typert 只读服务，零会话事件；不可用时返回 null）。 */
  currentMode(): Promise<string | null>;
  /** 是否允许在展开菜单时查询真实档位（来自配置 queryModeOnOpen）。 */
  queryOnOpen(): boolean;
  /** 订阅会话状态变化（用于在 /guard 命令后刷新图标）；返回取消订阅函数。 */
  subscribeSession(listener: () => void): () => void;
  /** 用户主动切换档位（执行 /guard <mode>）。 */
  switchMode(modeId: string): Promise<string>;
}

// ---------------------------------------------------------------
// 真实档位的客户端缓存：每个会话最多查询一次（12 小时内），切换档位时更新。
// 这样"展开菜单查询"不会变成每次展开都往会话里写命令事件。
// ---------------------------------------------------------------
const MODE_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
function modeCacheKey(sessionId: string): string {
  return `dsh-command-guard:session-mode:${sessionId}`;
}
function readCachedMode(sessionId: string | undefined): string | null {
  if (sessionId === undefined || typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(modeCacheKey(sessionId));
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as { mode?: unknown; at?: unknown };
    if (typeof parsed.mode !== "string" || typeof parsed.at !== "number") return null;
    if (Date.now() - parsed.at > MODE_CACHE_TTL_MS) return null;
    return parsed.mode;
  } catch {
    return null;
  }
}
function writeCachedMode(sessionId: string | undefined, mode: string): void {
  if (sessionId === undefined || typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(modeCacheKey(sessionId), JSON.stringify({ mode, at: Date.now() }));
  } catch {
    /* 隐私模式/配额不足时忽略 */
  }
}
/**
 * 输入区"命令审核"按钮（样式与旧版一致）：圆形"仅图标"按钮（与"+"号同款），
 * 用盾形图标的颜色/符号区分档位；点击后弹层**向上**展开，外部点击关闭。
 * 注意：初始档位只读 host settings（不执行任何命令），否则每次进入会话都会
 * 在会话里多出一条 `guard · …` 状态行。
 */
function GuardZone(props: { sessionId?: string; guardApi?: GuardZoneApi }) {
  const api = props.guardApi;
  const [current, setCurrent] = React.useState<string | null>(null);
  const [open, setOpen] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const hostRef = React.useRef<HTMLSpanElement | null>(null);

  // 初始档位：客户端缓存（真实值）优先，其次 settings 默认档。两者都无副作用。
  React.useEffect(() => {
    const cached = readCachedMode(props.sessionId);
    if (cached !== null) setCurrent(cached);
    if (!api || typeof api.defaultMode !== "function") return;
    let alive = true;
    api
      .defaultMode()
      .then((value) => {
        if (alive && cached === null && typeof value === "string") setCurrent(value);
      })
      .catch(() => {
        /* 读取失败时保持默认图标 */
      });
    return () => {
      alive = false;
    };
  }, [api, props.sessionId]);

  // 注意：展开菜单**不再查询**（旧实现会执行无参 `/guard`，导致每次点图标都写
  // command/run + command/done 两条事件）。图标只反映：本地缓存 → settings 默认档
  // → 本次会话内点击切换的结果。
  //
  // 已知限制：用输入框执行 `/guard <mode>` 时客户端无法感知——客户端 Session 不向
  // 第三方插件暴露事件流，命令也不会改动快照字段（buildSnapshot 只有 running 等），
  // 因此图标不会自动跟随。唯一干净的解法是 host 的 typert 只读方法。

  // 会话状态变化时刷新图标（输入 /guard <mode> 后自动跟随）。
  // 走 typert 只读查询（零会话事件），节流 800ms 以避开流式输出的高频触发。
  React.useEffect(() => {
    if (!api || typeof api.currentMode !== "function") return;
    let timer: any = null;
    let alive = true;
    const refresh = (): void => {
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        if (!alive) return;
        api
          .currentMode()
          .then((value) => {
            if (!alive || typeof value !== "string") return;
            setCurrent(value);
            writeCachedMode(props.sessionId, value);
          })
          .catch(() => {});
      }, 800);
    };
    refresh();
    const off = typeof api.subscribeSession === "function" ? api.subscribeSession(refresh) : () => {};
    // 已取消轮询：挂载时查一次 + 会话快照变化时再查（外加点击图标切换后的本地更新）。
    return () => {
      alive = false;
      if (timer !== null) clearTimeout(timer);
      off();
    };
  }, [api, props.sessionId]);

  // SSE：档位切换后 host 主动推送 {sessionId, mode}，图标实时跟随（零轮询、零会话事件）。
  React.useEffect(() => {
    if (typeof EventSource === "undefined") return;
    let source: any;
    try {
      source = new EventSource("/api/command-guard/events");
    } catch {
      return;
    }
    source.onmessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(String(event.data)) as { sessionId?: string; mode?: string };
        if (data?.sessionId !== props.sessionId || typeof data.mode !== "string") return;
        setCurrent(data.mode);
        writeCachedMode(props.sessionId, data.mode);
      } catch {
        /* 忽略非 JSON 帧 */
      }
    };
    return () => {
      try {
        source.close();
      } catch {
        /* 忽略 */
      }
    };
  }, [props.sessionId]);

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
        writeCachedMode(props.sessionId, id);
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
/** 默认档位可能所在的 settings namespace（按 dsh 版本从新到旧）。 */
const GUARD_SETTINGS_NS = ["command-guard", "commandGuard", "dsh-command-guard"];

export const inject = ["slots", "sessions", "commandUi", "typert"];
export function apply(ctx: any): void {
  // typert：**不自注册** TYPERT_REMOTE——官方 dsh-api-remotes 的 client 会从 host
  // 同步 typert 目录并自动创建 remote.<ns>；此前自注册会占用 package 名，
  // 反而把同步挡掉（实测 remote.commandGuard 一直不出现）。
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
  // typert 只读服务：host 注册 commandGuard 后，客户端会自动获得 remote.commandGuard。
  ctx.inject(["remote.commandGuard"], (scope: any) => {
    const remote = scope.remote?.commandGuard;
    if (remote !== undefined && typeof remote.sessionMode === "function") remoteGuard = remote;
  });
  // connection RPC：官方通道，优先用它查档位（自带同源鉴权、零会话事件）。
  // 先同步取一次（connection 是核心服务，apply 时已经就绪），再用 inject 兜底，
  // 避免首次查询时 rpcClient 还是 undefined 而静默退回 HTTP。
  const connectionNow = ctx.get("connection");
  if (connectionNow?.rpc !== undefined && typeof connectionNow.rpc.call === "function") rpcClient = connectionNow.rpc;
  ctx.inject(["connection"], (scope: any) => {
    const connection = scope.connection;
    if (connection?.rpc !== undefined && typeof connection.rpc.call === "function") rpcClient = connection.rpc;
  });
  // dsh 0.2.0+ 才启用 Markdown 渲染（旧版 labels 契约未验证，保持纯文本）。
  markdownEnabled = configForms !== undefined && MarkdownText !== undefined;

  const liveOf = (sessionId: string): any => {
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
  const readDefaultMode = async (): Promise<string | null> => {
    try {
      const face = settingsFace?.describe?.();
      if (face === undefined) return null;
      if (typeof face.ensure === "function") {
        try {
          await face.ensure();
        } catch {
          /* 忽略：拿不到快照就保持默认 */
        }
      }
      const snapshot = typeof face.getSnapshot === "function" ? face.getSnapshot() : undefined;
      const namespaces = snapshot?.view?.namespaces;
      if (!Array.isArray(namespaces)) return null;
      for (const ns of GUARD_SETTINGS_NS) {
        const entry = namespaces.find((item: any) => item?.ns === ns);
        const mode = entry?.value?.mode;
        if (typeof mode === "string") return mode;
      }
      // 兜底：entry id 由用户自定（cordis.patch.yml 里可任意命名），
      // 用"值恰好是合法档位"来认领。
      const byValue = namespaces.find(
        (item: any) => typeof item?.value?.mode === "string" && GUARD_MODES.some((m) => m.id === item.value.mode),
      );
      return typeof byValue?.value?.mode === "string" ? byValue.value.mode : null;
    } catch {
      return null;
    }
  };
  const guardSwitch = (sessionId: string, modeId: string): Promise<string> => {
    const live = liveOf(sessionId);
    if (live === undefined) return Promise.reject(new Error("session not materialized"));
    return live.command(`/guard ${modeId}`).then((result: any) => {
      if (!result?.ok) throw new Error("guard switch failed: " + (result?.error?.message ?? "unknown"));
      return result.value?.matched === true ? result.value.text : modeId;
    });
  };
  /**
   * 查询当前会话**真实**档位（/guard 无参）。
   * 会写 command/run + command/done 两条官方事件，所以只在客户端缓存失效时调用。
   */
  // 查询真实档位：**typert 优先**（零 HTTP、零会话事件）→ 只读 GET 路由回退。
  const guardCurrentMode = (sessionId: string): Promise<string | null> => {
    const fetchMode = (): Promise<string | null> => {
      if (typeof fetch !== "function") return Promise.resolve(null);
      return fetch(`/api/command-guard/session-mode?sessionId=${encodeURIComponent(sessionId)}`)
        .then((response: any) => (response.ok ? response.json() : null))
        .then((body: any) => (typeof body?.mode === "string" ? body.mode : null))
        .catch(() => null);
    };
    const remote = remoteGuard;
    if (remote !== undefined && typeof remote.sessionMode === "function") {
      return remote
        .sessionMode(sessionId)
        .then((result: any) => (typeof result?.mode === "string" ? result.mode : fetchMode()))
        .catch(() => fetchMode());
    }
    return fetchMode();
  };
  /** 读配置 queryModeOnOpen（默认 true = 显示准确优先）。 */
  const readQueryFlag = async (): Promise<boolean> => {
    try {
      const face = settingsFace?.describe?.();
      if (face === undefined) return true;
      const snapshot = typeof face.getSnapshot === "function" ? face.getSnapshot() : undefined;
      const namespaces = snapshot?.view?.namespaces;
      if (!Array.isArray(namespaces)) return true;
      for (const ns of GUARD_SETTINGS_NS) {
        const hit = namespaces.find((item: any) => item?.ns === ns);
        if (typeof hit?.value?.queryModeOnOpen === "boolean") return hit.value.queryModeOnOpen;
      }
      return true;
    } catch {
      return true;
    }
  };
  void readQueryFlag()
    .then((value) => {
      queryModeOnOpen = value;
    })
    .catch(() => {
      /* 读不到就用默认 true */
    });

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
          inject: (sessionId: string): { sessionId: string; guardApi: GuardZoneApi } => ({
            sessionId,
            guardApi: {
              defaultMode: readDefaultMode,
              currentMode: () => guardCurrentMode(sessionId),
              queryOnOpen: () => queryModeOnOpen,
              subscribeSession: (listener: () => void) => {
                const binding = sessions.binding(sessionId);
                const session = binding?.session;
                if (session === undefined || typeof session.subscribe !== "function") return () => {};
                return session.subscribe(listener);
              },
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

  // 3) 不再给 /guard 注册 popupSelect 装饰。
  //
  // dsh-client-ui-commands 的 popupSelect 只有 options/onSelect/available，没有
  // “空提交”通道：一旦注册，输入 `/guard` 回车会被强制弹出参数列表、必须选一项，
  // 于是无法发送无参 `/guard`（无参 = 查询当前档）。
  // 档位选择已由输入区左侧的盾形图标菜单覆盖，因此这里不注册装饰：
  // `/guard` 回到普通命令——无参=查询，带参=切换。
}
