// dsh-command-guard —— dsh 安装后处理脚本：为旧版（v0.1.1-rc.x）harness 的
// userQuestions wire schema 补上 guard-review intent 白名单。
//
// 为什么（旧版才需要）：v0.1.1 的 dsh-client-connection / dsh-host-apiproxy 在
// 解码 question 帧时把 intent.kind 限定为只允许 "plan-review"，未知 intent
// （guard-review）会让整帧被浏览器丢弃（控制台 ZodError），表现为命令被判定
// 风险后不弹卡、宿主 ask 挂起转圈。
//
// v0.1.2 起 harness 已移除该帧级 intent 白名单（不再有 plan-review zod union），
// guard-review 帧可直接通过，因此**新版不需要本补丁**——脚本会自动检测：
// 两个目标文件不存在（或不再含 plan-review 锁）时，打印提示并正常退出。
//
// 用法：
//   node tools/patch-dsh-question-intent.mjs --dsh "E:\\nvm\\v24.14.1\\node_modules\\@deepseek-ai\\dsh"
//   node tools/patch-dsh-question-intent.mjs --dsh <dsh-root> --undo   # 回滚（v0.1.1）
//
// 行为：幂等；真实修改前备份 <file>.bak-intent-guard-review；改后 node --check。
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";

const BACKUP_SUFFIX = ".bak-intent-guard-review";
const MARKER = "guard-review";

function parseArgs(argv) {
  const args = { dsh: process.env.DSH_ROOT, undo: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--undo") args.undo = true;
    else if (a.startsWith("--dsh=")) args.dsh = a.slice("--dsh=".length);
    else if (a === "--dsh") args.dsh = argv[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

function candidateRoots() {
  const list = [];
  if (process.env.DSH_ROOT) list.push(process.env.DSH_ROOT);
  list.push(
    "E:\\nvm\\v24.14.1\\node_modules\\@deepseek-ai\\dsh",
    "C:\\Program Files\\nodejs\\node_modules\\@deepseek-ai\\dsh",
  );
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  if (home) list.push(join(home, "AppData", "Local", "npm-cache", "_npx", "node_modules", "@deepseek-ai", "dsh"));
  return [...new Set(list.map((p) => resolve(p)))];
}

function locateDshRoot(explicit) {
  const candidates = explicit !== undefined && explicit !== "" ? [resolve(explicit)] : candidateRoots();
  for (const root of candidates) {
    const pkg = join(root, "package.json");
    if (!existsSync(pkg)) continue;
    try {
      const name = JSON.parse(readFileSync(pkg, "utf8")).name;
      if (name === "@deepseek-ai/dsh") return root;
    } catch {
      /* keep probing */
    }
  }
  const hint = process.platform === "win32"
    ? "例如：node tools/patch-dsh-question-intent.mjs --dsh \"E:\\nvm\\v24.14.1\\node_modules\\@deepseek-ai\\dsh\""
    : "例如：node tools/patch-dsh-question-intent.mjs --dsh /path/to/node_modules/@deepseek-ai/dsh";
  throw new Error(`找不到 @deepseek-ai/dsh 安装目录。请用 --dsh 指定（${hint}），或设置环境变量 DSH_ROOT。`);
}

/** 每个目标：(相对 dsh root 路径, 替换前, 替换后)。锚点必须唯一。 */
function targets() {
  return [
    {
      rel: join("node_modules", "@deepseek-ai", "dsh-client-connection", "lib", "client.js"),
      old: '\t\t\tintent: discriminatedUnion("kind", [object({\n\t\t\t\tkind: literal("plan-review"),\n\t\t\t\tapprove: string()\n\t\t\t})]).optional()',
      next: '\t\t\tintent: discriminatedUnion("kind", [object({\n\t\t\t\tkind: literal("plan-review"),\n\t\t\t\tapprove: string()\n\t\t\t}), object({\n\t\t\t\tkind: literal("guard-review"),\n\t\t\t\tapprove: string()\n\t\t\t})]).optional()',
    },
    {
      rel: join("node_modules", "@deepseek-ai", "dsh-host-apiproxy", "lib", "types", "api", "events.schema.js"),
      old: "        z.object({ kind: z.literal('plan-review'), approve: z.string() }),",
      next: "        z.object({ kind: z.literal('plan-review'), approve: z.string() }),\n        z.object({ kind: z.literal('guard-review'), approve: z.string() }),",
    },
  ];
}

/** v0.1.2+ 已移除 intent 白名单：目标文件不存在或已不含 plan-review 锁即视为无需补丁。 */
function needsLegacyPatch(root) {
  const conn = join(root, "node_modules", "@deepseek-ai", "dsh-client-connection", "lib", "client.js");
  if (!existsSync(conn)) return false;
  const text = readFileSync(conn, "utf8");
  return text.includes('literal("plan-review")') || text.includes("literal('plan-review')");
}

function patchFile(file, oldText, newText) {
  if (!existsSync(file)) return { file, status: "missing" };
  const text = readFileSync(file, "utf8");
  if (text.includes(MARKER)) return { file, status: "already-patched" };
  const count = text.split(oldText).length - 1;
  if (count !== 1) throw new Error(`${file}: 锚点匹配 ${count} 次（期望恰好 1 次），可能 dsh 版本结构已变；请人工检查后处理。`);
  const backup = file + BACKUP_SUFFIX;
  if (!existsSync(backup)) copyFileSync(file, backup);
  writeFileSync(file, text.replace(oldText, newText), "utf8");
  return { file, status: "patched", backup };
}

function undoFile(file) {
  const backup = file + BACKUP_SUFFIX;
  if (!existsSync(backup)) return { file, status: "no-backup" };
  copyFileSync(backup, file);
  return { file, status: "restored", backup };
}

function syntaxCheck(file) {
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

const args = parseArgs(process.argv);
const root = locateDshRoot(args.dsh);
console.log(`dsh root: ${root}`);
if (!needsLegacyPatch(root)) {
  console.log("检测到新版（v0.1.2+）结构：question intent 白名单已放开，guard-review 无需补丁。");
  console.log("本脚本保留用于旧版（v0.1.1-rc.x）安装；如确需对旧版执行，请 --dsh 指向旧版安装目录。");
  process.exit(0);
}
let changed = 0;
for (const { rel, old, next } of targets()) {
  const file = join(root, rel);
  const result = args.undo ? undoFile(file) : patchFile(file, old, next);
  console.log(`[${result.status}] ${rel}${result.backup ? ` (备份: ${result.backup})` : ""}`);
  if (result.status === "patched" || result.status === "restored") {
    if (!syntaxCheck(file)) throw new Error(`${file} 语法校验失败，请人工检查。`);
    changed += 1;
  }
  if (result.status === "missing") throw new Error(`缺少目标文件：${file}`);
}
console.log(changed > 0 ? "完成。请重启 dsh 并刷新浏览器使改动生效。" : "无需改动或已处理完毕。");
