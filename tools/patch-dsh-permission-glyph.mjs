// dsh-command-guard —— dsh 安装后处理脚本：为权限菜单里的自定义预设
// `guarded`（"帮我审核"）补一个图标。
//
// 为什么需要：权限选择器（dsh-client-ui-conversation 的 PermissionSelect）
// 只对设计集内的预设渲染图标，其余（包括 profile patch 里新增的 guarded）
// 一律落到 permissionGlyph() === undefined 的"无图标"分支。dsh 升级会覆盖
// node_modules，所以补丁必须重新执行；本脚本把它变成幂等、可撤销的一步。
//
// 兼容性：同一文件内的锚点 `const permissionGlyphs = new Map([` 在 dsh v0.1.2
// 与 v0.1.5 的 conversation 客户端产物中都唯一存在；脚本只做结构探测，找不到
// 锚点会明确报错且**不修改任何文件**。
//
// 为什么插入点在 `new Map([` 之后：Map 的最后一项通常**没有尾随逗号**，若把新
// 条目插到闭合 `]);` 之前却不补逗号，JS 会把
//   [FULL_ACCESS, …)] 换行 ["guarded", …)]
// 解析成索引访问 `[...][...]`（换行不触发 ASI），整个元素求值为 undefined，
// 于是 `new Map([…, undefined])` 在运行时抛
//   TypeError: Iterator value undefined is not an entry object
// 表现为 dsh 启动时报
//   failed to import loader entry … (@deepseek-ai/dsh-client-ui-conversation)
// 注意 `node --check` **发现不了**这类错误（`[a][b]` 语法合法），所以本脚本在
// 写盘前会把 Map 定义片段真正求值一次，确认条目数与 `guarded` 键都正确。
//
// 用法：
//   node tools/patch-dsh-permission-glyph.mjs --check        # 只探测与试算，不写
//   node tools/patch-dsh-permission-glyph.mjs                # 打补丁（自动备份）
//   node tools/patch-dsh-permission-glyph.mjs --undo         # 从备份还原
//   node tools/patch-dsh-permission-glyph.mjs --dsh <root>   # 显式指定 dsh 安装目录
//
// 行为：幂等、结构探测、Map 语义校验、备份 <file>.bak-permission-glyph、
// 改后 node --check，任何一步失败都从备份还原。
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";

const BACKUP_SUFFIX = ".bak-permission-glyph";
const TARGET_REL = join("node_modules", "@deepseek-ai", "dsh-client-ui-conversation", "lib", "client.js");
/** Map 起始处：把新条目插到它**之后**，新条目自带尾随逗号。 */
const ANCHOR = "const permissionGlyphs = new Map([\n";
/** 幂等标记：Map 里是否已有 guarded 键。 */
const MARKER = '["guarded"';
const MAP_OPEN = "const permissionGlyphs = new Map([";
const MAP_CLOSE = "\n\t\t]);";
/**
 * 插入的图标条目：盾牌轮廓（复用同文件内的 shieldOutline）+ 内部几何化字母 G
 * （表示"审核后再决定放行"，与 read-only 的对勾、danger 的感叹号区分开）。
 */
const ENTRY = [
  '\t\t\t["guarded", (0, react_jsx_runtime.jsxs)("svg", {',
  '\t\t\t\twidth: "16",',
  '\t\t\t\theight: "16",',
  '\t\t\t\tviewBox: "0 0 16 16",',
  '\t\t\t\tfill: "none",',
  '\t\t\t\t"aria-hidden": true,',
  '\t\t\t\tchildren: [(0, react_jsx_runtime.jsx)("path", {',
  "\t\t\t\t\td: shieldOutline,",
  '\t\t\t\t\tstroke: "currentColor",',
  '\t\t\t\t\tstrokeWidth: "1.31831",',
  '\t\t\t\t\tstrokeLinejoin: "round"',
  '\t\t\t\t}), (0, react_jsx_runtime.jsx)("path", {',
  '\t\t\t\t\td: "M9.6 5.9 A2 2 0 1 0 9.6 9.9 L9.6 8.1 L8.1 8.1",',
  '\t\t\t\t\tfill: "none",',
  '\t\t\t\t\tstroke: "currentColor",',
  '\t\t\t\t\tstrokeWidth: "1.35",',
  '\t\t\t\t\tstrokeLinecap: "round",',
  '\t\t\t\t\tstrokeLinejoin: "round"',
  '\t\t\t\t})]',
  '\t\t\t})],',
  "",
].join("\n");

function parseArgs(argv) {
  const args = { dsh: process.env.DSH_ROOT, undo: false, check: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--undo") args.undo = true;
    else if (a === "--check") args.check = true;
    else if (a.startsWith("--dsh=")) args.dsh = a.slice("--dsh=".length);
    else if (a === "--dsh") args.dsh = argv[++i];
    else throw new Error(`未知参数：${a}`);
  }
  return args;
}

/** 候选 dsh 安装目录：从当前 node 推导（nvm / nvm4w / 官方安装器），再补已知形态。 */
function candidateRoots() {
  const list = [];
  list.push(join(process.execPath, "..", "node_modules", "@deepseek-ai", "dsh"));
  try {
    const npmRoot = execFileSync("npm", ["root", "-g"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    if (npmRoot !== "") list.push(join(npmRoot, "@deepseek-ai", "dsh"));
  } catch {
    /* npm 不可用时忽略 */
  }
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
      if (JSON.parse(readFileSync(pkg, "utf8")).name === "@deepseek-ai/dsh") return root;
    } catch {
      /* 继续探测 */
    }
  }
  throw new Error(
    "找不到 @deepseek-ai/dsh 安装目录。请用 --dsh 指定（例如 "
    + "--dsh \"E:\\nvm4w\\nodejs\\node_modules\\@deepseek-ai\\dsh\"），或设置环境变量 DSH_ROOT。",
  );
}

/** 截取 `const permissionGlyphs = new Map([ … ]);` 源码片段。 */
function extractGlyphMapSource(text) {
  const start = text.indexOf(MAP_OPEN);
  if (start < 0) return undefined;
  const end = text.indexOf(MAP_CLOSE, start);
  if (end < 0) return undefined;
  return text.slice(start, end + MAP_CLOSE.length);
}

/**
 * 真正在沙箱里构造一次 permissionGlyphs Map（桩掉外部引用），
 * 从而发现「缺逗号导致元素为 undefined」这类 node --check 查不出的语义错误。
 * @param {string} text 目标文件内容。
 * @returns {string[]} Map 的键，按插入顺序。
 */
function evaluateGlyphMap(text) {
  const fragment = extractGlyphMapSource(text);
  if (fragment === undefined) throw new Error("无法定位 permissionGlyphs 的 Map 定义（结构可能已变化）");
  const prelude = [
    'const shieldOutline = "M0 0";',
    'const FULL_ACCESS = "danger-full-access";',
    'const react_jsx_runtime = { jsx: () => ({ tag: "jsx" }), jsxs: () => ({ tag: "jsxs" }) };',
    "",
  ].join("\n");
  const evaluate = new Function(`${prelude}${fragment}\nreturn [...permissionGlyphs.keys()];`);
  return evaluate();
}

/** 结构探测：返回可打补丁的文件内容与状态，或抛出具名错误。 */
function inspect(file) {
  if (!existsSync(file)) throw new Error(`缺少目标文件：${file}`);
  const text = readFileSync(file, "utf8");
  if (text.includes(MARKER)) return { text, status: "already-patched" };
  if (!text.includes(MAP_OPEN)) {
    throw new Error(`${file}: 未找到 permissionGlyphs Map，dsh 结构可能已变化，请人工检查。`);
  }
  if (!text.includes("const shieldOutline = ")) {
    throw new Error(`${file}: 未找到 shieldOutline 常量（新增图标复用它），dsh 结构可能已变化，请人工检查。`);
  }
  const count = text.split(ANCHOR).length - 1;
  if (count !== 1) {
    throw new Error(`${file}: 锚点匹配 ${count} 次（期望恰好 1 次），dsh 结构可能已变化，请人工检查；未修改任何文件。`);
  }
  return { text, status: "ready" };
}

function syntaxCheck(file) {
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/** 生成补丁文本并做完整试算；任一步失败即抛错（调用方负责不写盘）。 */
function buildPatched(text) {
  const candidate = text.replace(ANCHOR, ANCHOR + ENTRY);
  const before = evaluateGlyphMap(text);
  const after = evaluateGlyphMap(candidate);
  if (after.length !== before.length + 1) {
    throw new Error(`试算失败：补丁后 Map 条目数 ${after.length}，期望 ${before.length + 1}；未修改任何文件。`);
  }
  if (!after.includes("guarded")) {
    throw new Error("试算失败：补丁后 Map 里没有 guarded 键；未修改任何文件。");
  }
  if (!candidate.includes(MARKER)) {
    throw new Error("试算失败：补丁后文本缺少 guarded 条目；未修改任何文件。");
  }
  return { candidate, before, after };
}

const args = parseArgs(process.argv);
const root = locateDshRoot(args.dsh);
const file = join(root, TARGET_REL);
console.log(`dsh root: ${root}`);

if (args.undo) {
  const backup = file + BACKUP_SUFFIX;
  if (!existsSync(backup)) {
    console.log(`[no-backup] ${TARGET_REL}（没有备份可还原）`);
    process.exit(0);
  }
  copyFileSync(backup, file);
  if (!syntaxCheck(file)) throw new Error(`${file} 语法校验失败，请人工检查。`);
  const keys = evaluateGlyphMap(readFileSync(file, "utf8"));
  console.log(`[restored] ${TARGET_REL}（来自 ${backup}）；当前 Map 条目：${keys.join(", ")}`);
  console.log("完成。请重启 dsh 并刷新浏览器使改动生效。");
  process.exit(0);
}

const inspected = inspect(file);
if (inspected.status === "already-patched") {
  const keys = evaluateGlyphMap(inspected.text);
  console.log(`[already-patched] ${TARGET_REL}：guarded 图标已存在，无需处理。当前 Map 条目：${keys.join(", ")}`);
  process.exit(0);
}

const plan = buildPatched(inspected.text);

if (args.check) {
  console.log(`[ready] ${TARGET_REL}：结构探测通过（锚点唯一）。`);
  console.log(`  Map 条目：现有 ${plan.before.length} 个（${plan.before.join(", ")}）`);
  console.log(`  试算结果：补丁后 ${plan.after.length} 个（${plan.after.join(", ")}），Map 构造通过。`);
  console.log(`  将插入：${ENTRY.trim().split("\n")[0].trim()} …`);
  process.exit(0);
}

const backup = file + BACKUP_SUFFIX;
if (!existsSync(backup)) copyFileSync(file, backup);
writeFileSync(file, plan.candidate, "utf8");
if (!syntaxCheck(file)) {
  copyFileSync(backup, file);
  throw new Error(`${file} 语法校验失败，已从备份还原，请人工检查。`);
}
try {
  const keys = evaluateGlyphMap(readFileSync(file, "utf8"));
  console.log(`[patched] ${TARGET_REL}（备份：${backup}）`);
  console.log(`  Map 条目：${keys.join(", ")}`);
} catch (error) {
  copyFileSync(backup, file);
  throw new Error(`落盘后 Map 试算失败，已从备份还原：${error?.message ?? error}`);
}
console.log("完成。请重启 dsh 并刷新浏览器使改动生效。");
