// 会话级审核档位的持久化。
//
// 为什么不用会话事件：`command-guard/mode` 这类第三方事件会让 dsh 的冻结迁移链
// 直接拒绝整份会话日志（v0.1.5+ 连 ignorable 也不放行）。所以档位只落在**插件自己的
// JSON 文件**里，完全不触碰 harness 会话日志。
//
// 存储：$DSH_HOME/command-guard/session-modes.json（缺省 ~/.dsh/…）
// 结构：{ "version": 1, "modes": { "<sessionId>": { "mode": "agent-standard", "parent": "<父会话 id>|null", "at": 1700000000000 } } }
//
// 解析顺序（见 resolve）：本进程刚切换的值（同一张表）→ 自己的持久化值 →
// 父会话的值（分支继承）→ 默认档。继承结果会就地缓存一份（带 parent），
// 这样多级 fork（A → B → C，B 从未切过档）也能沿链传播。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** 一条会话档位记录。 */
interface ModeEntry {
  mode: string;
  /** 创建/继承时的父会话 id（用于多级分支继承）。 */
  parent: string | null;
  /** 最近写入时间（毫秒），用于惰性清理。 */
  at: number;
}

export interface SessionModeStoreOptions {
  /** dsh home；缺省读 DSH_HOME，再退到 ~/.dsh。 */
  home?: string;
  /** 记录 warn 日志（文件不可用等）。 */
  logger?: { warn(message?: unknown, ...args: unknown[]): void };
  /** 条目保留时长（毫秒），默认 90 天。 */
  ttlMs?: number;
  /** 最大条目数，默认 2000。 */
  maxEntries?: number;
}

const DEFAULT_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 2000;
const FORMAT_VERSION = 1;

/** 会话的最小面：id 与 header.parentSession。 */
export interface SessionRef {
  id?: string;
  header?: { parentSession?: string };
  parentSession?: string;
}

/**
 * 会话档位存储：懒加载 + 原子写 + 惰性清理。
 * 所有 IO 失败都只记 warn，绝不阻断审核流程。
 */
export class SessionModeStore {
  private readonly file: string;
  private readonly logger?: SessionModeStoreOptions["logger"];
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private modes = new Map<string, ModeEntry>();
  private loaded = false;
  private disabled = false;

  constructor(options: SessionModeStoreOptions = {}) {
    const home = options.home ?? process.env.DSH_HOME ?? join(homedir(), ".dsh");
    this.file = join(home, "command-guard", "session-modes.json");
    this.logger = options.logger;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  /** 读取存储文件（只读一次）。 */
  load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!existsSync(this.file)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8"));
      const modes = parsed?.modes;
      if (modes === null || typeof modes !== "object") return;
      for (const [id, raw] of Object.entries(modes as Record<string, unknown>)) {
        const entry = normalizeEntry(raw);
        if (entry !== undefined) this.modes.set(id, entry);
      }
      this.prune();
    } catch (error) {
      // 文件损坏：当作空表，不阻断插件
      this.logger?.warn(`[command-guard] 会话档位文件无法解析，已忽略：${String(error)}`);
      this.modes.clear();
    }
  }

  /** 取某会话自己的持久化档位（不含继承）。 */
  get(sessionId: string | undefined): string | undefined {
    if (sessionId === undefined) return undefined;
    this.load();
    return this.modes.get(sessionId)?.mode;
  }

  /** 写入某会话的档位（异步落盘，失败只 warn）。 */
  set(sessionId: string | undefined, mode: string, parent?: string): void {
    if (sessionId === undefined) return;
    this.load();
    this.modes.set(sessionId, { mode, parent: parent ?? null, at: Date.now() });
    this.persist();
  }

  /**
   * 解析某会话实际生效的档位。
   * 自己的值 → 父会话的值（分支继承，命中后缓存到本会话）→ 默认档。
   * @param session 会话（只需 id 与 header.parentSession）。
   * @param fallback 默认档（settings/config）。
   * @returns 实际档位 id。
   */
  resolve(session: SessionRef | undefined | null, fallback: string): string {
    this.load();
    const id = session?.id;
    if (typeof id !== "string") return fallback;
    const own = this.modes.get(id);
    if (own !== undefined) return own.mode;
    const parent = parentOf(session);
    if (parent !== undefined) {
      const parentEntry = this.modes.get(parent);
      if (parentEntry !== undefined) {
        // 缓存继承快照：让“父从未切档、父的父切过”的多级 fork 也能继续向上传播
        this.set(id, parentEntry.mode, parent);
        return parentEntry.mode;
      }
    }
    return fallback;
  }

  /** 当前条数（诊断用）。 */
  get size(): number {
    return this.modes.size;
  }

  /** 原子落盘：临时文件 + rename；失败只 warning 一次。 */
  private persist(): void {
    if (this.disabled) return;
    this.prune();
    const payload = JSON.stringify(
      { version: FORMAT_VERSION, modes: Object.fromEntries(this.modes), updatedAt: Date.now() },
      null,
      2,
    );
    const temporary = `${this.file}.tmp`;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(temporary, payload, "utf8");
      renameSync(temporary, this.file);
    } catch (error) {
      this.disabled = true;
      this.logger?.warn(`[command-guard] 会话档位无法写入 ${this.file}，本次运行只保留内存档位：${String(error)}`);
    }
  }

  /** 丢弃过期与超额条目（按最近写入时间）。 */
  private prune(): void {
    const now = Date.now();
    for (const [id, entry] of this.modes) {
      if (now - entry.at > this.ttlMs) this.modes.delete(id);
    }
    if (this.modes.size <= this.maxEntries) return;
    const ordered = [...this.modes.entries()].sort((a, b) => a[1].at - b[1].at);
    for (let i = 0; i < ordered.length - this.maxEntries; i += 1) {
      this.modes.delete(ordered[i][0]);
    }
  }
}

/** 取父会话 id：优先 header.parentSession，兼容平铺字段。 */
function parentOf(session: SessionRef | undefined | null): string | undefined {
  if (session === undefined || session === null) return undefined;
  const fromHeader = session.header?.parentSession;
  if (typeof fromHeader === "string" && fromHeader !== "") return fromHeader;
  const flat = session.parentSession;
  return typeof flat === "string" && flat !== "" ? flat : undefined;
}

/** 把磁盘上的任意值规整成一条合法记录。 */
function normalizeEntry(raw: unknown): ModeEntry | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  if (typeof record.mode !== "string") return undefined;
  const parent = typeof record.parent === "string" ? record.parent : null;
  const at = typeof record.at === "number" && Number.isFinite(record.at) ? record.at : Date.now();
  return { mode: record.mode, parent, at };
}
