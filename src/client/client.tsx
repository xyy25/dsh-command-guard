// dsh-command-guard 客户端 UI（web profile 的 client half）。
//
// 源码为 TSX（含 React/DOM），经 npm run build：
//   tsc 编译为 CJS 单文件 → build/bundle-client.mjs 包成
//   window.__ModuleLoader__.load({ id, factory }) 外壳 → 写入 client/client.js。
//
// 职责：
//   1. 为宿主 /guard 命令装饰弹层：斜杠菜单选中或裸输入 "/guard" 回车 →
//      弹出档位下拉（popupSelect）。
//   2. 设置页 General 区"权限"行下方注册"命令审核"行：读写 host settings
//      namespace "commandGuard" 的 mode（新会话默认档位）。
//   3. 输入框工具栏（conversation.input.left）注册常驻"命令审核"下拉：
//      点开即见五档并可切换当前会话档位。
//
// 档位机器值与 lib/modes.ts 保持一致（client 是独立产物不能 import host 模块）。

import * as React from "react";
import { Menu, IconChevronDownOutline14, MarkdownText, Button } from "@deepseek-ai/dsh-client-ui-primitives";
import { createSnapshotStore } from "@deepseek-ai/dsh-client-runtime/client";
import { PendingQuestion } from "@deepseek-ai/dsh-client-ui-user-questions";

// ---------------------------------------------------------------------------
// 样式：与官方权限行一致的视觉。样式以字符串注入 <style>（无 CSS 构建链）。
// ---------------------------------------------------------------------------

/** 若尚未注入则把一段 CSS 挂到 <head>（幂等）。 */
function injectStyle(tagId: string, css: string): void {
  if (typeof document === "undefined") return;
  if (document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) !== null) return;
  const tag = document.createElement("style");
  tag.dataset.plugin = "dsh-command-guard";
  tag.dataset.pluginCss = tagId;
  tag.textContent = css;
  document.head.appendChild(tag);
}

/** 设置行样式。 */
const ROW_CSS =
  ".oY77xG_row{border-bottom:1px solid var(--dsw-alias-border-l2);align-items:center;gap:8px;padding:16px 0;display:flex}" +
  ".oY77xG_rowText{flex-direction:column;flex:1;gap:4px;min-width:0;padding-right:48px;display:flex}" +
  ".oY77xG_title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}" +
  ".oY77xG_desc{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400;line-height:18px}" +
  ".oY77xG_selector{background:var(--dsw-alias-bg-module-platform);height:36px;font:inherit;color:var(--dsw-alias-label-primary);cursor:pointer;border:none;border-radius:18px;align-items:center;gap:12px;padding:0 14px;font-size:14px;line-height:22px;display:inline-flex}" +
  ".oY77xG_selector:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}" +
  ".oY77xG_selector:disabled{cursor:default}.oY77xG_chevron{flex:none}";

const ROW_CLASSES = Object.freeze({
  row: "oY77xG_row",
  rowText: "oY77xG_rowText",
  title: "oY77xG_title",
  desc: "oY77xG_desc",
  selector: "oY77xG_selector",
  chevron: "oY77xG_chevron",
});

/** 输入区按钮样式。 */
const ZONE_CSS =
  ".cgZn_selector{background:var(--dsw-alias-bg-module-platform);width:28px;height:28px;font:inherit;color:var(--dsw-alias-label-primary);cursor:pointer;border:none;border-radius:14px;align-items:center;justify-content:center;gap:0;padding:0;font-size:13px;line-height:20px;display:inline-flex}" +
  ".cgZn_selector:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}" +
  ".cgZn_selector:disabled{cursor:default}.cgZn_chevron{flex:none}" +
  ".cgZn_error{color:var(--dsw-alias-state-error-primary);font-weight:700;margin-right:4px}" +
  ".cgZn_popover{background:var(--dsw-specific-input-major);border:1px solid var(--dsw-alias-border-l2-darkmode-thin);border-radius:12px;box-shadow:var(--dsw-shadow-lv2);color:var(--dsw-alias-label-primary);padding:6px;z-index:1200}" +
  ".cgZn_popover [role=menuitem]:hover{background:var(--dsw-alias-interactive-bg-hover)}" +
  ".cgZn_popoverActive{background:var(--dsw-alias-interactive-bg-hover);font-weight:600}";

const ZONE_CLASSES = Object.freeze({
  selector: "cgZn_selector",
  chevron: "cgZn_chevron",
  error: "cgZn_error",
  popover: "cgZn_popover",
  popoverActive: "cgZn_popoverActive",
});

injectStyle("dsh-command-guard/GuardModeRow.module.css", ROW_CSS);
injectStyle("dsh-command-guard/GuardZone.module.css", ZONE_CSS);

// ---------------------------------------------------------------------------
// 档位静态选项（设置行下拉、/guard 弹层、输入区按钮共用）。
// ---------------------------------------------------------------------------

interface ModeOption {
  id: string;
  label: string;
  detail?: string;
}

const MODE_OPTIONS: ModeOption[] = [
  { id: "rules", label: "硬规则判定", detail: "规则引擎按配置自动判定（现有行为）；命中即向你确认" },
  { id: "agent-very-loose", label: "Agent 判定 · 极宽松", detail: "仅当 agent 判定为 critical（不可逆破坏）时才确认" },
  { id: "agent-loose", label: "Agent 判定 · 宽松", detail: "agent 判定为 high 及以上（明显破坏性）时确认" },
  { id: "agent-standard", label: "Agent 判定 · 标准", detail: "agent 判定为 medium 及以上（有副作用）时确认" },
  { id: "agent-strict", label: "Agent 判定 · 严格", detail: "agent 判定为 low 及以上（存疑即确认），仅明显安全的命令放行" },
];

// ---------------------------------------------------------------------------
// 设置行（General 区，"权限"行正下方）
// ---------------------------------------------------------------------------

interface GuardModeRowProps {
  /** 行保存动作（写 commandGuard.mode）。 */
  select(mode: string): void;
  /** 首次渲染加载（读 mirror）。 */
  load(): void;
  /** 由注入面 hooks.guardMode 绑定的 store 快照 hook。 */
  useGuardMode?: (selector: (snapshot: unknown) => unknown) => unknown;
  /** 行字典翻译。 */
  t(key: string): string;
}

function GuardModeRow({ load, select, useGuardMode, t }: GuardModeRowProps) {
  const state = (useGuardMode ? useGuardMode((snapshot: any) => snapshot) : null) as any;
  const [open, setOpen] = React.useState(false);
  React.useEffect(() => {
    load();
  }, [load]);
  React.useEffect(() => {
    if (state?.writable && state?.status !== "unavailable") return;
    setOpen(false);
  }, [state?.status, state?.writable]);

  if (state == null || state.status === "unavailable") return null;

  const selected = state.options?.find((option: any) => option.id === state.currentValue);
  const busy = state.status === "loading" || state.status === "saving";
  const label = selected?.label ?? (busy ? t("loading") : t("unavailable"));
  const description = state.error ?? t("description");

  return (
    <>
      <div className={ROW_CLASSES.row}>
        <div className={ROW_CLASSES.rowText}>
          <div className={ROW_CLASSES.title}>{t("title")}</div>
          <div className={ROW_CLASSES.desc} role={state.error === null ? undefined : "alert"}>
            {description}
          </div>
        </div>
        <Menu
          open={open}
          onClose={() => setOpen(false)}
          items={(state.options ?? []).map((option: any) => ({ id: option.id, label: option.label }))}
          selectedId={state.currentValue}
          onSelect={(id: string) => {
            setOpen(false);
            if (id === state.currentValue) return;
            select(id);
          }}
          align="end"
          portal
          anchor={
            <button
              type="button"
              className={ROW_CLASSES.selector}
              aria-haspopup="menu"
              aria-expanded={open}
              disabled={busy || !state.writable || state.options?.length === 0}
              onClick={() => setOpen((value) => !value)}
            >
              {label}
              <IconChevronDownOutline14 className={ROW_CLASSES.chevron} />
            </button>
          }
        />
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// 输入区常驻档位下拉（conversation.input.left 条目）
// ---------------------------------------------------------------------------

/** 输入区按钮固定标题（zone 条目没有 locale 机制，与档位选项一致固定中文）。 */
const ZONE_LABEL = "命令审核";

/** 档位 → 图标状态：颜色（按阈值由浅到深）+ 符号（rules 用字母，agent 档用点数 1–4）。 */
const MODE_ICON: Record<string, { color: string; dotCount: number; letter?: string }> = Object.freeze({
  rules: { color: "#8ab4f8", dotCount: 0, letter: "R" },
  "agent-very-loose": { color: "#7fd4a0", dotCount: 1 },
  "agent-loose": { color: "#f2c14e", dotCount: 2 },
  "agent-standard": { color: "#f39a4b", dotCount: 3 },
  "agent-strict": { color: "#e0574f", dotCount: 4 },
});

/** 盾形守卫图标：模式状态用颜色 + 符号区分，供"仅图标"按钮使用。 */
function ShieldIcon({ mode }: { mode: string }) {
  const conf = MODE_ICON[mode] ?? MODE_ICON.rules;
  const dots: number[] = [];
  for (let i = 0; i < conf.dotCount; i += 1) dots.push(i);
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 1.2L13.8 3v4.1c0 3.9-2.3 6.7-5.8 7.8C4.5 13.8 2.2 11 2.2 7.1V3z" fill={conf.color} />
      {conf.letter
        ? (
          <text x="8" y="11" textAnchor="middle" fontSize="7" fontWeight="700" fill="#0b1220" style={{ userSelect: "none" }}>
            {conf.letter}
          </text>
        )
        : dots.map((i) => (
          <circle key={i} cx={8 - (conf.dotCount - 1) * 1.7 + i * 3.4} cy="8.6" r="1.1" fill="#0b1220" />
        ))}
    </svg>
  );
}

interface GuardZoneProps {
  /** owner 提供的会话快照（InputZone.session）。 */
  session?: { sessionId?: string } | null;
  /** 注入：执行一次档位切换（走宿主 /guard <mode>）。 */
  pickMode?(sessionId: string, mode: string): Promise<void>;
  /** 注入：读取当前档位（读 settings 默认档，无任何宿主命令副作用）。 */
  readDefaultMode?(sessionId?: string): Promise<string | null>;
}

function GuardZone({ session, pickMode, readDefaultMode }: GuardZoneProps) {
  const [open, setOpen] = React.useState(false);
  const [current, setCurrent] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const hostRef = React.useRef<HTMLSpanElement | null>(null);
  const sessionId = session?.sessionId;

  // 初始档位：读 settings 默认档（不触发宿主命令，避免在会话里产生"guard · …"状态行）
  React.useEffect(() => {
    let alive = true;
    if (typeof readDefaultMode === "function") {
      void readDefaultMode(sessionId).then((mode) => {
        if (alive && mode !== null) setCurrent(mode);
      }).catch(() => {
        /* 读取默认档失败不影响交互 */
      });
    }
    return () => {
      alive = false;
    };
  }, [readDefaultMode, sessionId]);

  // 点击外部关闭向上弹层
  React.useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (hostRef.current && !hostRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const fail = (where: string, cause: unknown): void => {
    const message = cause instanceof Error ? cause.message : String(cause);
    try {
      console.error(`[dsh-command-guard] GuardZone ${where}:`, cause);
    } catch {
      /* console 不可用时静默 */
    }
    setError(`${where} 失败：${message}`);
  };

  const pick = async (id: string): Promise<void> => {
    setOpen(false);
    if (sessionId === undefined) {
      setError("zone 未提供会话信息（client 装配问题），请改用 /guard 命令");
      setOpen(true);
      return;
    }
    if (typeof pickMode !== "function") {
      setError("档位切换通道未注入（client 装配问题），请改用 /guard 命令");
      setOpen(true);
      return;
    }
    try {
      await pickMode(sessionId, id);
      setCurrent(id);
      setError(null);
    } catch (cause) {
      fail("切换档位", cause);
      setOpen(true);
    }
  };

  const currentLabel = (() => {
    if (current === null) return null;
    return MODE_OPTIONS.find((option) => option.id === current)?.label ?? null;
  })();

  return (
    <span ref={hostRef} style={{ position: "relative", display: "inline-flex", alignItems: "center" }}>
      {error !== null && (
        <span className={ZONE_CLASSES.error} title={error} aria-label={error}>
          !
        </span>
      )}
      <button
        type="button"
        className={ZONE_CLASSES.selector}
        aria-haspopup="menu"
        aria-expanded={open}
        title={error ?? (currentLabel ? `${ZONE_LABEL}（当前：${currentLabel}）` : ZONE_LABEL)}
        onClick={() => setOpen((value) => !value)}
      >
        <ShieldIcon mode={current ?? "rules"} />
      </button>
      {open && (
        <div
          role="menu"
          className={ZONE_CLASSES.popover}
          style={{
            position: "absolute",
            bottom: "calc(100% + 6px)",
            left: "0",
            minWidth: "200px",
            maxHeight: "min(320px, 60vh)",
            overflowY: "auto",
          }}
        >
          {MODE_OPTIONS.map((option) => {
            const active = option.id === current;
            return (
              <div
                key={option.id}
                role="menuitem"
                className={active ? ZONE_CLASSES.popoverActive : undefined}
                style={{ fontSize: 13, lineHeight: "20px", padding: "8px 12px", cursor: "pointer" }}
                title={option.detail}
                onClick={() => void pick(option.id)}
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

// ---------------------------------------------------------------------------
// 确认卡（approval 风格：一次点击生效 + 可选输入框）
// ---------------------------------------------------------------------------

/** 确认卡固定文案（composer 条目无 locale 依赖时仍可用；同时提供 zh/en 字典）。 */
const APPROVAL_LOCALES_ZH = {
  waiting: "命令审核需确认",
  placeholder: "（可选）告诉 Agent 希望如何调整",
  reject: "拒绝执行",
  submit: "提交",
  allow: "允许执行",
};
const APPROVAL_LOCALES_EN = {
  waiting: "Command review required",
  placeholder: "(optional) tell the Agent how to adjust",
  reject: "Reject",
  submit: "Submit",
  allow: "Allow",
};

const APPROVAL_CSS =
  ".gzc_root{padding:8px calc(var(--dsh-composer-side-clearance) + 16px) 12px;flex-direction:column;align-items:center;display:flex}" +
  ".gzc_card{width:100%;max-width:var(--dsh-chat-content-width);border:1px solid var(--dsw-alias-state-warn-secondary);background:var(--dsw-specific-input-major);box-shadow:var(--dsw-shadow-lv2);border-radius:20px;overflow:hidden}" +
  ".gzc_strip{background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-state-warn-primary);align-items:center;gap:8px;padding:10px 16px;font-size:13px;line-height:18px;display:flex}" +
  ".gzc_dot{background:var(--dsw-alias-state-warn-primary);border-radius:50%;width:8px;height:8px}" +
  ".gzc_body{box-sizing:border-box;max-height:min(50vh,420px);padding:12px 16px 0;color:var(--dsw-alias-label-primary);overflow-y:auto}" +
  ".gzc_actionRow{justify-content:flex-end;align-items:center;gap:8px;padding:12px 16px 14px;display:flex}" +
  ".gzc_input{background:var(--dsw-alias-bg-module-platform);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;color:var(--dsw-alias-label-primary);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;padding:6px 10px;width:min(220px,40vw);outline:none}" +
  ".gzc_input:focus{border-color:var(--dsw-alias-state-warn-primary)}";

const APPROVAL_CLASSES = Object.freeze({
  root: "gzc_root",
  card: "gzc_card",
  strip: "gzc_strip",
  dot: "gzc_dot",
  body: "gzc_body",
  actionRow: "gzc_actionRow",
  input: "gzc_input",
});

injectStyle("dsh-command-guard/GuardApprovalCard.module.css", APPROVAL_CSS);

interface GuardApprovalCardProps {
  /** composer 链 selector 命中后传入的 raw pending（kind === "question"）。 */
  matched: any;
}

/**
 * 确认卡：与沙箱拦截的 approval 面板同风格（警告条 + 可滚动命令/说明 + 右下角按钮）。
 * 按钮一次点击即生效；左侧输入框有内容时，拒绝按钮变为"提交"并携带文本回传 host。
 */
function GuardApprovalCard({ matched }: GuardApprovalCardProps) {
  const pending = React.useMemo(() => (matched ? new PendingQuestion(matched) : null), [matched]);
  const question = pending?.questions?.[0];
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  if (pending === null || question === undefined) return null;

  const approveLabel = typeof question?.intent?.approve === "string" ? question.intent.approve : APPROVAL_LOCALES_ZH.allow;
  const options = Array.isArray(question?.options) ? question.options : [];
  const denyOption = options.find((option: any) => option.label !== approveLabel);
  const denyLabel = typeof denyOption?.label === "string" ? denyOption.label : APPROVAL_LOCALES_ZH.reject;
  const hasNote = note.trim().length > 0;

  const commit = async (label: string, custom?: string): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      await pending.answer({
        answers: [{ id: question.id, selected: [label], ...(custom !== undefined ? { custom } : {}) }],
      });
    } catch {
      setBusy(false);
    }
  };

  return (
    <div className={APPROVAL_CLASSES.root} data-guard-approval-key={pending.key}>
      <div className={APPROVAL_CLASSES.card}>
        <div className={APPROVAL_CLASSES.strip}>
          <span className={APPROVAL_CLASSES.dot} />
          {APPROVAL_LOCALES_ZH.waiting}
        </div>
        <div className={APPROVAL_CLASSES.body} data-guard-approval-scroll="" tabIndex={0} role="group" aria-label="命令审核详情">
          <MarkdownText text={question.detail ?? ""} />
        </div>
        <div className={APPROVAL_CLASSES.actionRow}>
          <input
            className={APPROVAL_CLASSES.input}
            value={note}
            disabled={busy}
            placeholder={APPROVAL_LOCALES_ZH.placeholder}
            aria-label={APPROVAL_LOCALES_ZH.placeholder}
            onChange={(event) => setNote(event.currentTarget.value)}
          />
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void commit(denyLabel, hasNote ? note.trim() : undefined)}
          >
            {hasNote ? APPROVAL_LOCALES_ZH.submit : APPROVAL_LOCALES_ZH.reject}
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void commit(approveLabel)}>
            {APPROVAL_LOCALES_ZH.allow}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 设置行字典
// ---------------------------------------------------------------------------

const ROW_LOCALES: Record<string, Record<string, Record<string, string>>> = {
  "settings.commandGuard": {
    zh: {
      title: "命令审核",
      description: "选择新会话的默认命令审核模式",
      loading: "加载中",
      unavailable: "不可用",
    },
    en: {
      title: "Command guard",
      description: "Choose the default command review mode for new sessions",
      loading: "Loading",
      unavailable: "Unavailable",
    },
  },
};

// ---------------------------------------------------------------------------
// 设置读写控制器（读写 commandGuard.mode）
// ---------------------------------------------------------------------------

const GUARD_SETTINGS_NS = "commandGuard";

/** settings mirror 的描述面（宽松）。 */
interface DescribeMirrorFace {
  subscribe(listener: () => void): () => void;
  ensure(): Promise<void>;
  getSnapshot(): any;
  acceptView(view: unknown): void;
}

interface SettingsApiLike {
  settings: {
    mutate(request: unknown): Promise<{ result: { ok: boolean; error?: { message: string }; value?: unknown } }>;
  };
}

interface SettingsSchemaLike {
  rehydrate(schema: unknown): unknown;
  nodeAtPath(schema: unknown, path: string[]): any;
}

/** 从 mirror 视图解析动态档位枚举（label 来自 host schema 的 const description）。 */
function modeValueOf(view: any, schema: SettingsSchemaLike): { currentValue: string; options: { id: string; label: string }[] } {
  const value = view.value?.mode;
  if (typeof value !== "string") throw new Error("commandGuard settings has no mode value");
  const node = schema.nodeAtPath(schema.rehydrate(view.schema), ["mode"]);
  if (node === undefined) throw new Error("commandGuard settings schema has no mode field");
  const options = (node.type === "union" ? node.list ?? [] : [node]).flatMap((candidate: any) => {
    const choice = candidate;
    if (choice.type !== "const" || typeof choice.value !== "string") return [];
    const described = choice.meta?.description;
    return [{
      id: choice.value,
      label: typeof described === "string" && described.length > 0 ? described : choice.value,
    }];
  });
  if (options.length === 0 || !options.some((option: any) => option.id === value)) {
    throw new Error("commandGuard settings schema does not advertise its current mode");
  }
  return { currentValue: value, options };
}

interface RowSnapshot {
  status: string;
  error: string | null;
  writable: boolean;
  currentValue: string;
  options: { id: string; label: string }[];
  revision: number;
}

/** 行控制器：跟随 mirror 并写回默认档位（仿官方 permission-presets 客户端）。 */
class GuardModeSettingsController {
  private following: (() => void) | undefined;
  private saving = false;
  private disposed = false;

  /** 行快照 store（通过注入面 hooks.guardMode 提供给组件）。 */
  store = createSnapshotStore<RowSnapshot>({
    status: "idle",
    error: null,
    writable: false,
    currentValue: "",
    options: [],
    revision: 0,
  });

  constructor(
    private readonly describeFace: DescribeMirrorFace,
    private readonly api: SettingsApiLike,
    private readonly schema: SettingsSchemaLike,
  ) {}

  async load(): Promise<void> {
    if (this.disposed) return;
    this.following ??= this.describeFace.subscribe(() => {
      this.derive();
    });
    this.store.update((state) => {
      state.status = "loading";
      state.error = null;
    });
    await this.describeFace.ensure();
    this.derive();
  }

  async select(mode: string): Promise<void> {
    const state = this.store.getSnapshot();
    const view = this.describeFace.getSnapshot().view?.namespaces?.find((entry: any) => entry.ns === GUARD_SETTINGS_NS);
    if (view === undefined || !state.writable || this.saving) return;
    this.saving = true;
    this.store.update((draft) => {
      draft.status = "saving";
      draft.error = null;
    });
    try {
      const response = await this.api.settings.mutate({
        ns: GUARD_SETTINGS_NS,
        ops: [{ op: "set", path: ["mode"], value: mode }],
        expectedRevision: view.revision,
      });
      if (!response.result.ok) throw new Error(response.result.error?.message);
      this.saving = false;
      if (this.disposed) return;
      this.describeFace.acceptView(response.result.value);
    } catch (error) {
      this.saving = false;
      if (this.disposed) return;
      this.fail(error);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.following?.();
    this.following = undefined;
  }

  private derive(): void {
    if (this.disposed || this.saving) return;
    const mirrored = this.describeFace.getSnapshot();
    if (mirrored.status === "unavailable" || mirrored.view === undefined) {
      this.store.update((state) => {
        state.status = "unavailable";
        state.writable = false;
        state.currentValue = "";
        state.options = [];
      });
      return;
    }
    const view = mirrored.view.namespaces?.find((entry: any) => entry.ns === GUARD_SETTINGS_NS);
    if (view === undefined) {
      this.store.update((state) => {
        state.status = "unavailable";
        state.writable = false;
        state.currentValue = "";
        state.options = [];
      });
      return;
    }
    try {
      const resolved = modeValueOf(view, this.schema);
      const { writable } = mirrored.view;
      this.store.update((state) => {
        state.status = "ready";
        state.error = null;
        state.writable = writable;
        state.currentValue = resolved.currentValue;
        state.options = resolved.options;
        state.revision = view.revision;
      });
    } catch (error) {
      this.fail(error);
    }
  }

  private fail(error: unknown): void {
    this.store.update((state) => {
      state.status = "error";
      state.error = error instanceof Error ? error.message : String(error);
    });
  }
}

// ---------------------------------------------------------------------------
// 客户端插件装配
// ---------------------------------------------------------------------------

/** 客户端 ctx 的最小面（宽松）。 */
interface GuardClientCtx {
  get(name: string): unknown;
  effect(callback: () => void | (() => void), label?: string): void;
  locale: {
    register(ns: string, dictionaries: Record<string, Record<string, string>>): () => void;
  };
  slots: {
    inject(name: string, register: () => void): void;
    register(options: Record<string, unknown>, component: any): void;
  };
  settingsScope?: any;
  settingsSchema?: any;
}

export const inject = [
  "commandUi",
  "sessions",
  "slots",
  "locale",
  "connection",
  "remote",
  "settingsScope",
  "settingsSchema",
];

export function apply(ctx: GuardClientCtx): void {
  const warn = (where: string, error: unknown): void => {
    try {
      console.warn(`[dsh-command-guard] ${where} failed:`, error);
    } catch {
      /* console 不可用时静默 */
    }
  };

  // 1) 宿主 /guard 命令装饰：菜单选中或裸输入 "/guard" 回车 → 弹档位下拉
  //    （独立 try/catch：即使设置行失败也不影响弹层入口）
  try {
    const commandUi = ctx.get("commandUi") as
      | {
          decorate(decoration: Record<string, unknown>): void;
        }
      | undefined;
    const sessionFor = (session: { sessionId?: string }) => {
      const sessions = ctx.get("sessions") as any;
      return sessions?.binding(session.sessionId)?.session;
    };
    if (commandUi !== undefined) {
      ctx.effect(() => commandUi.decorate({
        name: "guard",
        available: () => true,
        ui: {
          kind: "popupSelect",
          options: async () => MODE_OPTIONS.map((option) => ({
            id: option.id,
            label: option.label,
            ...(option.detail !== undefined ? { detail: option.detail } : {}),
          })),
          onSelect: async (option: ModeOption, session: { sessionId?: string }) => {
            const live = sessionFor(session);
            if (live === undefined) throw new Error("this session is not materialized yet");
            const result = await live.command(`/guard ${option.id}`);
            if (!result.ok) throw new Error(`guard switch failed: ${result.error.code}: ${result.error.message}`);
            if (!result.value.matched) throw new Error("the host offers no /guard command");
          },
        },
      }), "ui-command-guard: /guard decoration");
    }
  } catch (error) {
    warn("/guard decoration", error);
  }

  // 2) 设置行（新会话默认档位）：独立 try/catch，失败不拖垮其余注册
  try {
    const connection = ctx.get("connection") as { api?: SettingsApiLike } | undefined;
    if (connection?.api === undefined) throw new Error("connection service unavailable");
    const controller = new GuardModeSettingsController(
      ctx.settingsScope.describe() as DescribeMirrorFace,
      connection.api,
      ctx.settingsSchema as SettingsSchemaLike,
    );
    const load = (): Promise<void> => controller.load();
    const select = (mode: string): Promise<void> => controller.select(mode);
    const injected = (): Record<string, unknown> => ({
      hooks: { guardMode: controller.store },
      load,
      select,
    });
    ctx.effect(() => () => {
      controller.dispose();
    }, "ui-command-guard: settings row directory");
    ctx.effect(() => ctx.locale.register(
      "settings.commandGuard",
      { zh: ROW_LOCALES["settings.commandGuard"].zh, en: ROW_LOCALES["settings.commandGuard"].en },
    ), "ui-command-guard: settings row dictionaries");
    ctx.slots.inject("settings.general.item", () => ctx.slots.register({
      name: "settings.general.item",
      id: "command-guard-mode",
      order: -18,
      locale: "settings.commandGuard",
      inject: injected,
    }, GuardModeRow));
  } catch (error) {
    warn("settings row", error);
  }

  // 3) 输入区常驻"命令审核"图标下拉（conversation.input.left，权限选择同排）
  //    切换走宿主 /guard <mode>（一次）。读取当前档位改为读 settings 默认档，
  //    不再用裸 /guard 查询（避免在会话里产生"guard · …"状态行）。
  try {
    const runGuard = async (sessionId: string, mode: string): Promise<void> => {
      const sessions = ctx.get("sessions") as any;
      const live = sessions?.binding(sessionId)?.session;
      if (live === undefined) throw new Error("this session is not materialized yet");
      const result = await live.command(`/guard ${mode}`);
      if (!result.ok) throw new Error(`guard switch failed: ${result.error.code}: ${result.error.message}`);
      if (!result.value.matched) throw new Error("the host offers no /guard command");
    };
    const readDefaultMode = async (): Promise<string | null> => {
      try {
        const mirror = (ctx.settingsScope as any)?.describe?.()?.getSnapshot?.();
        const ns = mirror?.view?.namespaces?.find((entry: any) => entry.ns === GUARD_SETTINGS_NS);
        const mode = ns?.value?.mode;
        return typeof mode === "string" ? mode : null;
      } catch {
        return null;
      }
    };
    ctx.slots.inject("conversation.input.left", () => ctx.slots.register({
      name: "conversation.input.left",
      id: "command-guard-zone",
      order: 0,
      inject: () => ({
        pickMode: async (sessionId: string, mode: string): Promise<void> => {
          await runGuard(sessionId, mode);
        },
        readDefaultMode,
      }),
    }, GuardZone));
  } catch (error) {
    warn("input-zone guard select", error);
  }

  // 4) 确认卡：composer 链上接管"guard-review"提问，渲染 approval 风格卡片
  //    （一次点击生效 + 输入框：有内容时拒绝按钮变"提交"并携带文本回传）。
  try {
    ctx.slots.inject("conversation.composer", () => ctx.slots.register({
      name: "conversation.composer",
      priority: -5,
      select: (owner: any) => {
        const raw = (owner?.interactions ?? []).find(
          (interaction: any) =>
            interaction?.kind === "question" &&
            interaction?.payload?.questions?.[0]?.intent?.kind === "guard-review",
        );
        return raw ?? null;
      },
      locale: "guard.approval",
    }, GuardApprovalCard));
    ctx.effect(() => ctx.locale.register(
      "guard.approval",
      { zh: { ...APPROVAL_LOCALES_ZH }, en: { ...APPROVAL_LOCALES_EN } },
    ), "ui-command-guard: approval card dictionaries");
  } catch (error) {
    warn("approval card composer", error);
  }
}
