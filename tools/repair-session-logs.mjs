// dsh-command-guard —— 会话日志修复脚本：让被污染的 v0 历史会话在
// dsh v0.1.5+ 的冻结格式迁移链（v0 → v1 → v2 → v3）下重新可读。
//
// 背景（为什么需要本脚本）
//   dsh v0.1.5 引入了 dsh-session-format-* 冻结迁移链。v0 → v1 的坐标校验
//   （dsh-session-format-v0-to-v1/lib/index.js）对**未知事件类型**无条件拒绝，
//   连带 ignorable: true 的事件也不放行：
//     format v0 contains unknown historical event type "command-guard/mode"
//     at seq 103636; migration refuses unknown historical events even when ignorable
//   因此早期“给自定义事件打 ignorable 标记”的修复方式在新版完全失效。
//
//   本脚本不修改 dsh 源码，而是就地修复**会话日志数据**：
//     A 类：删除 v0 冻结清单之外的未知事件（本插件早期版本写入的
//           command-guard/* ，以及其它第三方自定义事件），并把其后所有
//           序号引用整体前移，保持 seq 稠密。
//     B 类：删除已冻结事件里不被允许的多余 payload 成员（本次为
//           permission/preset 的 origin —— 这是 dsh 自身冻结清单的缺口，
//           与本插件无关）。
//   修复后文件仍是合法的 v0 格式；dsh 首次打开时会自行迁移为 v3 并写回。
//
//   无法自动修复的情况（脚本会如实报告且绝不写盘）：关系校验失败，例如
//     assistant/message repeats advertised tool call <callId>
//   这类历史不一致涉及消息内容与工具调用生命周期，改动风险不可控，应作为
//   dsh 上游问题反馈或另行人工重建。
//
// 用法：
//   node tools/repair-session-logs.mjs                     # 默认 dry-run，只报告
//   node tools/repair-session-logs.mjs --apply             # 写盘（自动备份）
//   node tools/repair-session-logs.mjs --undo              # 从备份还原
//   node tools/repair-session-logs.mjs --only <sessionId>  # 只处理匹配的会话
//   node tools/repair-session-logs.mjs --dsh <dsh-root>    # 显式指定 dsh 安装目录
//
// 注意：
//   - 建议先**完全退出 dsh** 再执行 --apply，避免 Windows 文件占用导致写盘失败。
//   - 修复后的会话被 dsh 打开一次就会迁移成 v3；那之后旧版 dsh（0.1.2 及
//     之前）将无法再读该会话。脚本保留 `<file>.pre-repair.bak` 作为唯一回退。
import { copyFileSync, existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import zlib from "node:zlib";

/** dsh 会话日志里被打包成一行多事件的物理行类型。 */
const PACKED_ROW_TYPES = new Set(["text-chunks", "reasoning-chunks", "tool-call-chunks"]);
/** Zstandard 帧魔数（小端读入 0xFD2FB528）。 */
const ZSTD_MAGIC = 4247762216;
/** 备份后缀：脚本唯一的回退凭据。 */
const BACKUP_SUFFIX = ".pre-repair.bak";
/** 写回的压缩参数：与 dsh 自身写入时一致（带帧校验和）。 */
const ZSTD_OPTIONS = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } };

// ---------------------------------------------------------------------------
// 命令行参数
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { apply: false, undo: false, only: undefined, dsh: process.env.DSH_ROOT, sessions: undefined };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") args.apply = true;
    else if (a === "--dry-run") args.apply = false;
    else if (a === "--undo") args.undo = true;
    else if (a.startsWith("--only=")) args.only = a.slice("--only=".length);
    else if (a === "--only") args.only = argv[++i];
    else if (a.startsWith("--dsh=")) args.dsh = a.slice("--dsh=".length);
    else if (a === "--dsh") args.dsh = argv[++i];
    else if (a.startsWith("--sessions=")) args.sessions = a.slice("--sessions=".length);
    else if (a === "--sessions") args.sessions = argv[++i];
    else throw new Error(`未知参数：${a}`);
  }
  return args;
}

// ---------------------------------------------------------------------------
// 定位 dsh 安装目录
// ---------------------------------------------------------------------------

function candidateRoots() {
  const list = [];
  // 1) 从当前 node 可执行文件推导（nvm / nvm4w / 官方安装器布局都适用）
  const exeDir = join(process.execPath, "..");
  list.push(join(exeDir, "node_modules", "@deepseek-ai", "dsh"));
  // 2) npm 全局根
  try {
    const npmRoot = execFileSync("npm", ["root", "-g"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    if (npmRoot !== "") list.push(join(npmRoot, "@deepseek-ai", "dsh"));
  } catch {
    /* npm 不可用时忽略 */
  }
  // 3) 已知的路径形态（历史与当前）
  list.push(
    "E:\\nvm4w\\nodejs\\node_modules\\@deepseek-ai\\dsh",
    "E:\\nvm\\v24.14.1\\node_modules\\@deepseek-ai\\dsh",
    "C:\\Program Files\\nodejs\\node_modules\\@deepseek-ai\\dsh",
  );
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  if (home !== "") list.push(join(home, "AppData", "Local", "npm-cache", "_npx", "node_modules", "@deepseek-ai", "dsh"));
  return [...new Set(list.map((p) => resolve(p)))];
}

function locateDshRoot(explicit) {
  const candidates = explicit !== undefined && explicit !== "" ? [resolve(explicit)] : candidateRoots();
  for (const root of candidates) {
    const pkg = join(root, "package.json");
    if (!existsSync(pkg)) continue;
    try {
      const parsed = JSON.parse(readFileSync(pkg, "utf8"));
      if (parsed.name === "@deepseek-ai/dsh") return root;
    } catch {
      /* 继续探测 */
    }
  }
  throw new Error(
    "找不到 @deepseek-ai/dsh 安装目录。请用 --dsh 指定（例如 "
    + "--dsh \"E:\\nvm4w\\nodejs\\node_modules\\@deepseek-ai\\dsh\"），或设置环境变量 DSH_ROOT。",
  );
}

// ---------------------------------------------------------------------------
// 加载 dsh 的会话格式工具（校验与迁移的权威实现）
// ---------------------------------------------------------------------------

async function loadFormatKit(root) {
  const nested = join(root, "node_modules", "@deepseek-ai");
  const catalogPath = join(nested, "dsh-session-format-catalog", "lib", "index.js");
  const v0Path = join(nested, "dsh-session-format-v0-to-v1", "lib", "index.js");
  if (!existsSync(catalogPath) || !existsSync(v0Path)) {
    throw new Error(
      "当前 dsh 安装缺少会话格式包（dsh-session-format-catalog / dsh-session-format-v0-to-v1）。"
      + "本脚本需要 dsh v0.1.5+ 才能做权威校验；请确认 --dsh 指向的是 v0.1.5 及以上的安装目录。",
    );
  }
  const catalogModule = await import(pathToFileURL(catalogPath).href);
  const v0Module = await import(pathToFileURL(v0Path).href);
  return {
    catalog: catalogModule.sessionFormatCatalog,
    dispositions: v0Module.RELEASED_V0_EVENT_DISPOSITIONS,
    assertPayload: v0Module.assertReleasedEventPayload,
  };
}

// ---------------------------------------------------------------------------
// Zstandard 多帧容器：严格帧扫描（与 dsh 的 scanZstdFrames 同语义）
// ---------------------------------------------------------------------------

/**
 * 解析多帧 zstd 容器，只认帧结构与块结构，不做解压。
 * @param {Buffer} buffer 会话文件字节。
 * @returns {{frames: Array<{start:number,end:number}>, error?: string, tornStart?: number}}
 */
function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) return { frames, error: `第 ${offset} 字节处帧魔数非法` };
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) return { frames, error: `第 ${offset - 1} 字节处帧头保留位非零` };
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) return { frames, error: `第 ${offset - 3} 字节处块类型保留` };
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return { frames };
}

/**
 * 读取一个会话日志：单行 header 帧 + 后续帧拼成的事件文本。
 * @param {string} file 会话文件路径。
 * @returns {{headerText:string, header:object, eventText:string, frameCount:number, raw:Buffer}}
 */
function readSessionLog(file) {
  const raw = readFileSync(file);
  const scanned = scanZstdFrames(raw);
  if (scanned.error !== undefined) throw new Error(`zstd 帧结构损坏：${scanned.error}`);
  if (scanned.tornStart !== undefined) throw new Error(`zstd 帧不完整（结尾在第 ${scanned.tornStart} 字节处被截断）`);
  if (scanned.frames.length === 0) throw new Error("文件里没有任何 zstd 帧");
  const [first, ...rest] = scanned.frames;
  const headerText = zlib.zstdDecompressSync(raw.subarray(first.start, first.end)).toString("utf8");
  if (!headerText.endsWith("\n") || headerText.indexOf("\n") !== headerText.length - 1) {
    throw new Error("第一个 zstd 帧不是恰好一行 header（dsh 要求 header 单独成帧）");
  }
  const parts = [];
  for (const frame of rest) parts.push(zlib.zstdDecompressSync(raw.subarray(frame.start, frame.end)).toString("utf8"));
  return { headerText, header: JSON.parse(headerText.trim()), eventText: parts.join(""), frameCount: scanned.frames.length, raw };
}

/** 事件文本 → 物理行数组（去掉空行）。 */
function parseRows(eventText) {
  return eventText.split("\n").filter((line) => line !== "").map((line) => JSON.parse(line));
}

function deepCopy(value) {
  return JSON.parse(JSON.stringify(value));
}

// ---------------------------------------------------------------------------
// 审计：找出必须删除的事件、必须删除的多余 payload 成员、以及不可修复项
// ---------------------------------------------------------------------------

/**
 * 审计一份事件的深拷贝。
 * @param {object[]} events 事件的深拷贝（会被就地删改）。
 * @param {object} kit 会话格式工具。
 * @returns {{drops:number[], payloadFixes:Map<number,string[]>, unfixable:string[], unknownTypes:Map<string,number>}}
 */
function auditEvents(events, kit) {
  const drops = [];
  const payloadFixes = new Map();
  const unfixable = [];
  const unknownTypes = new Map();
  events.forEach((event, index) => {
    const type = event?.type;
    if (typeof type !== "string") {
      unfixable.push(`第 ${index} 行缺少事件类型`);
      return;
    }
    if (PACKED_ROW_TYPES.has(type)) return;
    if (kit.dispositions[type] === undefined) {
      // 冻结清单之外的未知事件：唯一安全的做法是整条删除
      unknownTypes.set(type, (unknownTypes.get(type) || 0) + 1);
      if (typeof event.seq !== "number") unfixable.push(`未知事件 ${type} 缺少 seq，无法安全删除`);
      else drops.push(event.seq);
      return;
    }
    // 已知事件：只删除“多余成员”，其它问题一律视为不可修复
    const removed = [];
    for (let attempt = 0; attempt < 16; attempt++) {
      let failure;
      try {
        kit.assertPayload(event, 0);
        break;
      } catch (error) {
        failure = error;
      }
      const match = /unexpected member "([^"]+)"/.exec(String(failure?.message ?? ""));
      if (match === null || event.data === null || typeof event.data !== "object") {
        unfixable.push(`${type} @seq ${String(event.seq)}：${String(failure?.message ?? failure).slice(0, 160)}`);
        break;
      }
      delete event.data[match[1]];
      removed.push(match[1]);
    }
    if (removed.length > 0) payloadFixes.set(index, removed);
  });
  return { drops: [...new Set(drops)].sort((a, b) => a - b), payloadFixes, unfixable, unknownTypes };
}

/** 收集一条事件对其它事件序号的全部引用（用于确认被删事件无人引用）。 */
function collectSeqRefs(event) {
  const refs = [];
  const push = (value) => {
    if (typeof value === "number") refs.push(value);
  };
  if (Array.isArray(event.sourceEventSeqs)) {
    for (const entry of event.sourceEventSeqs) {
      if (Array.isArray(entry)) {
        push(entry[0]);
        push(entry[1]);
      } else push(entry);
    }
  }
  const operation = event.surfaceOp;
  if (operation !== null && typeof operation === "object") {
    push(operation.start);
    push(operation.end);
  }
  const data = event.data;
  if (data !== null && typeof data === "object") {
    if (Array.isArray(data.shadowedSeqs)) for (const value of data.shadowedSeqs) push(value);
    const range = data.shadowedRange;
    if (range !== null && typeof range === "object") {
      push(range.start);
      push(range.end);
    }
    if (Array.isArray(data.messageSeqs)) for (const value of data.messageSeqs) push(value);
    push(data.sourceEventSeq);
    push(data.throughSeq);
  }
  return refs;
}

/** 检查被删事件是否落在某个打包行的序号区间内（落在里面就必须拆行，超出本脚本能力）。 */
function findSpanningRuns(events, drops) {
  const dropSet = new Set(drops);
  const spanning = [];
  for (const event of events) {
    if (typeof event.seq0 !== "number") continue;
    const steps = Array.isArray(event.data?.dt) ? event.data.dt.length + 1 : 1;
    for (const drop of dropSet) {
      if (drop >= event.seq0 && drop <= event.seq0 + steps - 1) spanning.push({ rowType: event.type, seq0: event.seq0, steps, drop });
    }
  }
  return spanning;
}

/** 检查被删事件是否被别人引用。 */
function findDanglingRefs(events, drops) {
  const dropSet = new Set(drops);
  const dangling = [];
  for (const event of events) {
    for (const ref of collectSeqRefs(event)) {
      if (dropSet.has(ref)) dangling.push({ rowType: event.type, seq: event.seq, ref });
    }
  }
  return dangling;
}

// ---------------------------------------------------------------------------
// 修复：删除未知事件 + 删除多余成员 + 序号整体前移
// ---------------------------------------------------------------------------

function makeSeqMapper(drops) {
  return (value) => value - drops.filter((drop) => drop < value).length;
}

function mapSeqList(list, map) {
  return list.map((entry) => {
    if (Array.isArray(entry)) return entry.map((value) => (typeof value === "number" ? map(value) : value));
    return typeof entry === "number" ? map(entry) : entry;
  });
}

/** 就地重编号一条物理行里的全部序号引用（打包行的 dt 是差分，绝不能动）。 */
function renumberRow(row, map) {
  if (typeof row.seq === "number") row.seq = map(row.seq);
  if (typeof row.seq0 === "number") row.seq0 = map(row.seq0);
  if (Array.isArray(row.sourceEventSeqs)) row.sourceEventSeqs = mapSeqList(row.sourceEventSeqs, map);
  const operation = row.surfaceOp;
  if (operation !== null && typeof operation === "object") {
    if (typeof operation.start === "number") operation.start = map(operation.start);
    if (typeof operation.end === "number") operation.end = map(operation.end);
  }
  const data = row.data;
  if (data === null || typeof data !== "object") return;
  if (Array.isArray(data.shadowedSeqs)) data.shadowedSeqs = data.shadowedSeqs.map(map);
  const range = data.shadowedRange;
  if (range !== null && typeof range === "object") {
    if (typeof range.start === "number") range.start = map(range.start);
    if (typeof range.end === "number") range.end = map(range.end);
  }
  if (Array.isArray(data.messageSeqs)) data.messageSeqs = data.messageSeqs.map(map);
  if (typeof data.sourceEventSeq === "number") data.sourceEventSeq = map(data.sourceEventSeq);
  if (typeof data.throughSeq === "number") data.throughSeq = map(data.throughSeq);
}

/**
 * 依据审计结论，从原始行生成修复后的行。
 * @param {object[]} rawRows 原始物理行（只读使用）。
 * @param {{drops:number[], payloadFixes:Map<number,string[]>}} plan 审计结论。
 * @returns {object[]} 修复后的物理行（全新对象）。
 */
function repairRows(rawRows, plan) {
  const dropSet = new Set(plan.drops);
  const map = makeSeqMapper(plan.drops);
  const output = [];
  rawRows.forEach((raw, index) => {
    const isDropped = typeof raw.seq === "number" && dropSet.has(raw.seq)
      && typeof raw.type === "string" && !PACKED_ROW_TYPES.has(raw.type);
    if (isDropped) return;
    const row = deepCopy(raw);
    for (const key of plan.payloadFixes.get(index) ?? []) delete row.data[key];
    if (plan.drops.length > 0) renumberRow(row, map);
    output.push(row);
  });
  return output;
}

// ---------------------------------------------------------------------------
// 校验：用 dsh 自己的目录做 v0 → v3 全链路校验
// ---------------------------------------------------------------------------

function verifyRows(header, rows, kit) {
  try {
    const restore = kit.catalog.createRestore(header, { recovery: "strict", validation: "current" });
    for (const row of rows) restore.decodeRow(row);
    const artifact = restore.finish();
    return { ok: true, version: artifact.header.version, eventCount: artifact.events.length };
  } catch (error) {
    return { ok: false, name: error?.constructor?.name ?? "Error", message: String(error?.message ?? error) };
  }
}

// ---------------------------------------------------------------------------
// 写回与还原
// ---------------------------------------------------------------------------

function writeLogBack(file, headerText, rows) {
  const eventsText = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
  const headerFrame = zlib.zstdCompressSync(Buffer.from(headerText, "utf8"), ZSTD_OPTIONS);
  const eventFrame = zlib.zstdCompressSync(Buffer.from(eventsText, "utf8"), ZSTD_OPTIONS);
  const temporary = `${file}.repair.tmp`;
  writeFileSync(temporary, Buffer.concat([headerFrame, eventFrame]));
  renameSync(temporary, file);
}

function backupOf(file) {
  return file + BACKUP_SUFFIX;
}

// ---------------------------------------------------------------------------
// 单个会话的处理流程
// ---------------------------------------------------------------------------

function classifyFailure(message) {
  if (message.includes("repeats advertised tool call")) return "C 类（关系校验：同一步内重复广播同一 tool-call）";
  if (message.includes("refuses unknown historical event type")) return "A 类残留（仍有未知事件）";
  if (message.includes("unexpected member")) return "B 类残留（仍有多余 payload 成员）";
  return "其它";
}

function processFile(file, args, kit) {
  const label = file.replace(/\\/g, "/").split("/").slice(-3, -1).join("/");
  const result = { file, label, actions: [], status: "clean", detail: "" };

  // --undo：只从备份还原
  if (args.undo) {
    const backup = backupOf(file);
    if (!existsSync(backup)) {
      result.status = "no-backup";
      return result;
    }
    copyFileSync(backup, file);
    result.status = "restored";
    result.actions.push("已从备份还原");
    return result;
  }

  const { headerText, header, eventText } = readSessionLog(file);
  const rawRows = parseRows(eventText);
  const auditRows = deepCopy(rawRows);
  const audit = auditEvents(auditRows, kit);

  if (audit.unfixable.length > 0) {
    result.status = "unfixable";
    result.detail = audit.unfixable.slice(0, 3).join("；");
    return result;
  }
  if (audit.drops.length === 0 && audit.payloadFixes.size === 0) {
    // 已修复过，或本来干净
    const check = verifyRows(header, deepCopy(rawRows), kit);
    result.status = check.ok ? "clean" : "unfixable";
    if (!check.ok) result.detail = `${check.name}: ${check.message}`;
    return result;
  }

  // 安全前置检查：打包行跨越、以及引用被删事件，都超出脚本能力
  const spanning = audit.drops.length > 0 ? findSpanningRuns(rawRows, audit.drops) : [];
  if (spanning.length > 0) {
    result.status = "unfixable";
    result.detail = `被删事件落在打包行内（${JSON.stringify(spanning[0])}），需要拆行，脚本不处理`;
    return result;
  }
  const dangling = audit.drops.length > 0 ? findDanglingRefs(rawRows, audit.drops) : [];
  if (dangling.length > 0) {
    result.status = "unfixable";
    result.detail = `存在指向被删事件的引用（${JSON.stringify(dangling[0])}），需要人工介入`;
    return result;
  }

  const fixedRows = repairRows(rawRows, audit);
  const check = verifyRows(header, deepCopy(fixedRows), kit);
  if (!check.ok) {
    result.status = "unfixable";
    result.detail = `${check.name}: ${check.message}（${classifyFailure(check.message)}）`;
    return result;
  }

  for (const [type, count] of audit.unknownTypes) result.actions.push(`删除未知事件 ${type} × ${count}`);
  for (const [index, keys] of audit.payloadFixes) {
    result.actions.push(`清理 ${rawRows[index]?.type} @seq ${String(rawRows[index]?.seq)} 的多余成员 ${keys.join(", ")}`);
  }
  result.actions.push(`物理行 ${rawRows.length} → ${fixedRows.length}，校验通过（v${check.version}）`);
  result.status = args.apply ? "repaired" : "would-repair";

  if (args.apply) {
    const backup = backupOf(file);
    if (!existsSync(backup)) copyFileSync(file, backup);
    try {
      writeLogBack(file, headerText, fixedRows);
    } catch (error) {
      throw new Error(`写盘失败（若 dsh 正在运行，请先完全退出 dsh 再重试）：${error?.message ?? error}`);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// 扫描会话目录
// ---------------------------------------------------------------------------

function collectSessionFiles(root, only) {
  const files = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name === "session.jsonl.zstd") {
        if (only === undefined || full.includes(only)) files.push(full);
      }
    }
  };
  walk(root);
  return files.sort();
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

const args = parseArgs(process.argv);
const dshRoot = locateDshRoot(args.dsh);
const sessionsRoot = args.sessions ?? join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "sessions");
if (!existsSync(sessionsRoot)) throw new Error(`找不到会话目录：${sessionsRoot}`);

const kit = await loadFormatKit(dshRoot);
console.log(`dsh root      : ${dshRoot}`);
console.log(`会话目录      : ${sessionsRoot}`);
console.log(`运行模式      : ${args.undo ? "撤销还原" : args.apply ? "写入修复" : "只读检查（dry-run）"}`);
console.log(`当前格式版本  : v${kit.catalog.currentVersion}`);
console.log("");

const files = collectSessionFiles(sessionsRoot, args.only);
if (files.length === 0) throw new Error("没有匹配的 session.jsonl.zstd 文件");

const results = [];
for (const file of files) {
  try {
    results.push(processFile(file, args, kit));
  } catch (error) {
    results.push({ file, label: file.split("\\").slice(-3, -1).join("/"), actions: [], status: "error", detail: String(error?.message ?? error) });
  }
}

console.log("结果：");
for (const item of results) {
  const tag = {
    clean: "干净",
    "would-repair": "待修复",
    repaired: "已修复",
    unfixable: "不可自动修复",
    restored: "已还原",
    "no-backup": "无备份",
    error: "读取失败",
  }[item.status] ?? item.status;
  console.log(`  [${tag}] ${item.label}`);
  if (item.detail !== "") console.log(`      ${item.detail}`);
  for (const action of item.actions) console.log(`      · ${action}`);
}

const count = (status) => results.filter((item) => item.status === status).length;
console.log("");
console.log(
  `汇总：共 ${results.length} 个会话；干净 ${count("clean")}，`
  + `待修复 ${count("would-repair")}，已修复 ${count("repaired")}，`
  + `不可自动修复 ${count("unfixable")}，读取失败 ${count("error")}。`,
);
if (!args.apply && !args.undo && count("would-repair") > 0) {
  console.log("这是只读检查。确认上面的修复项后，请执行：node tools/repair-session-logs.mjs --apply");
}
if (args.apply && count("repaired") > 0) {
  console.log("修复完成。请重启 dsh；被修复的会话首次打开时会自动迁移为当前格式并写回。");
  console.log(`如需回退：node tools/repair-session-logs.mjs --undo（备份后缀 ${BACKUP_SUFFIX}）。`);
}
if (count("unfixable") > 0 || count("error") > 0) {
  console.log("存在无法自动处理或读取失败的会话，请把上面的明细反馈给维护者。");
  process.exitCode = 1;
}
