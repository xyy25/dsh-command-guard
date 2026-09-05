// dsh-command-guard —— dsh v0.1.2 安装后处理：让官方 composer occupant 对
// guard-review 提问"让位"，从而允许插件自绘确认卡被 conversation.composer
// 槽渲染（不降级为通用问答）。
//
// 为什么需要：v0.1.2 的 conversation.composer 是 chain/overlay 槽——遍历
// occupant 逐个 select，只渲染第一个匹配者；官方 dsh-client-ui-user-questions
// 的 occupant 对所有 PendingQuestion（含 guard-review）都返回自身，第三方
// occupant 永远无法接管。官方槽渲染还要求 occupant 携带私有 store face，
// 第三方无法在该槽自绘（直接注册会导致输入区崩溃）。本脚本仅让官方对
// intent.kind === "guard-review" 返回 null，使 chain 继续到我们的 occupant。
// plan-review 与普通提问行为不变。
//
// 用法：
//   node tools/patch-dsh-composer-guard-review.mjs --dsh "<dsh-root>"
//   node tools/patch-dsh-composer-guard-review.mjs --dsh "<dsh-root>" --undo
//
// 行为：结构探测（找不到锚点报错）、幂等、修改前备份 .bak-composer-guard-review、
// 改后 node --check。升级 dsh 后需重跑。
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";

const BACKUP_SUFFIX = ".bak-composer-guard-review";

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

function locateDshRoot(explicit) {
  const candidates = explicit !== undefined && explicit !== "" ? [resolve(explicit)] : [resolve("E:\\nvm\\v24.14.1\\node_modules\\@deepseek-ai\\dsh")];
  for (const root of candidates) {
    const pkg = join(root, "package.json");
    if (!existsSync(pkg)) continue;
    try {
      if (JSON.parse(readFileSync(pkg, "utf8")).name === "@deepseek-ai/dsh") return root;
    } catch {
      /* keep probing */
    }
  }
  throw new Error(`找不到 @deepseek-ai/dsh 安装目录。请用 --dsh 指定。`);
}

const rel = join("node_modules", "@deepseek-ai", "dsh-client-ui-user-questions", "lib", "client.js");
const OLD = "select: ({ pendingInteraction }) => pendingInteraction instanceof PendingQuestion ? pendingInteraction : null,";
const NEW = "select: ({ pendingInteraction }) => (pendingInteraction instanceof PendingQuestion && pendingInteraction.questions?.[0]?.intent?.kind !== \"guard-review\" ? pendingInteraction : null),";

function patchFile(file) {
  const text = readFileSync(file, "utf8");
  if (text.includes("kind !== \"guard-review\"")) return { status: "already-patched" };
  const count = text.split(OLD).length - 1;
  if (count !== 1) throw new Error(`${file}: 未找到唯一锚点（匹配 ${count} 次），dsh 结构可能已变化，请人工检查。`);
  const backup = file + BACKUP_SUFFIX;
  if (!existsSync(backup)) copyFileSync(file, backup);
  writeFileSync(file, text.replace(OLD, NEW), "utf8");
  return { status: "patched", backup };
}

function undoFile(file) {
  const backup = file + BACKUP_SUFFIX;
  if (!existsSync(backup)) return { status: "no-backup" };
  copyFileSync(backup, file);
  return { status: "restored", backup };
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
const file = join(root, rel);
console.log(`dsh root: ${root}`);
if (!existsSync(file)) throw new Error(`缺少目标文件：${file}`);
const result = args.undo ? undoFile(file) : patchFile(file);
console.log(`[${result.status}] ${rel}${result.backup ? ` (备份: ${result.backup})` : ""}`);
if (result.status === "patched" || result.status === "restored") {
  if (!syntaxCheck(file)) throw new Error(`${file} 语法校验失败，请人工检查。`);
}
console.log("完成。请重启 dsh 并刷新浏览器使改动生效。");
