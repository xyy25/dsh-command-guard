// dsh-command-guard —— dsh 安装后处理脚本：让官方 composer occupant 对
// guard-review 提问"让位"，从而允许插件自绘确认卡被 conversation.composer
// 槽渲染（不降级为通用问答）。
//
// 为什么需要：conversation.composer 是 chain/overlay 槽——遍历 occupant
// 逐个 select，只渲染第一个匹配者；官方 dsh-client-ui-user-questions 的
// occupant 对所有 PendingQuestion（含 guard-review）都返回自身，第三方
// occupant 永远无法接管。官方槽渲染还要求 occupant 携带私有 store face，
// 第三方无法在该槽自绘（直接注册会导致输入区崩溃）。本脚本仅让官方对
// intent.kind === "guard-review" 返回 null，使 chain 继续到我们的 occupant。
// plan-review 与普通提问行为不变。
//
// 兼容性：目标表达式在 dsh v0.1.2 与 v0.1.5 的
// node_modules/@deepseek-ai/dsh-client-ui-user-questions/lib/client.js 中
// 逐字符一致。dsh 升级会覆盖 node_modules，因此升级后需要重新执行本脚本。
//
// 用法：
//   node tools/patch-dsh-composer-guard-review.mjs --check        # 只探测，不写
//   node tools/patch-dsh-composer-guard-review.mjs                # 打补丁（自动备份）
//   node tools/patch-dsh-composer-guard-review.mjs --undo         # 从备份还原
//   node tools/patch-dsh-composer-guard-review.mjs --dsh <root>   # 显式指定 dsh 安装目录
//
// 行为：结构探测（找不到锚点报错且不修改文件）、补丁文本自检、幂等、备份
// <file>.bak-composer-guard-review、改后 node --check，失败即从备份回滚。
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";

const BACKUP_SUFFIX = ".bak-composer-guard-review";
const TARGET_REL = join("node_modules", "@deepseek-ai", "dsh-client-ui-user-questions", "lib", "client.js");
const OLD = "select: ({ pendingInteraction }) => pendingInteraction instanceof PendingQuestion ? pendingInteraction : null,";
const NEW = "select: ({ pendingInteraction }) => (pendingInteraction instanceof PendingQuestion && pendingInteraction.questions?.[0]?.intent?.kind !== \"guard-review\" ? pendingInteraction : null),";
/** 幂等标记：已打过补丁的文件必然含此片段。 */
const MARKER = 'kind !== "guard-review"';

function parseArgs(argv) {
  const args = { dsh: process.env.DSH_ROOT, undo: false, check: false, force: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--undo") args.undo = true;
    else if (a === "--check") args.check = true;
    else if (a === "--force") args.force = true;
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

/** 结构探测：返回可打补丁的文件内容与状态，或抛出具名错误。 */
function inspect(file) {
  if (!existsSync(file)) throw new Error(`缺少目标文件：${file}`);
  const text = readFileSync(file, "utf8");
  if (text.includes(MARKER)) return { text, status: "already-patched" };
  const count = text.split(OLD).length - 1;
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

/** 读 dsh 版本号（读不到时返回空串）。 */
function readDshVersion(root) {
  try {
    return JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version ?? "";
  } catch {
    return "";
  }
}

/** 判断是否 dsh 0.2.0 及以上（预发布同样按主次版本比较）。 */
function isAtLeast020(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (match === null) return false;
  return Number(match[1]) > 0 || Number(match[2]) >= 2;
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
  console.log(`[restored] ${TARGET_REL}（来自 ${backup}）`);
  console.log("完成。请重启 dsh 并刷新浏览器使改动生效。");
  process.exit(0);
}

// dsh 0.2.0 起 conversation.composer 仍是 chain 槽，且注册时按 priority 升序排列：
// 本插件 occupant 的 priority = -20 先于官方 occupant 的 0，select 直接接管
// guard-review，无需再让官方"让位"。默认跳过；确需强制打补丁时加 --force。
const version = readDshVersion(root);
if (!args.force && isAtLeast020(version)) {
  console.log(`[skipped] dsh ${version}：composer chain 按 priority 选举（本插件 -20 先于官方 0），`);
  console.log("          确认卡已由本插件接管，无需让位补丁。若实测未接管，可加 --force 强制打补丁。");
  process.exit(0);
}

const inspected = inspect(file);
if (inspected.status === "already-patched") {
  console.log(`[already-patched] ${TARGET_REL}：guard-review 让位补丁已存在，无需处理。`);
  process.exit(0);
}

// 先在内存里构造补丁文本并自检：旧表达式必须消失、新表达式必须出现。
const candidate = inspected.text.replace(OLD, NEW);
if (candidate.includes(OLD) || !candidate.includes(NEW)) {
  throw new Error(`${file}: 生成补丁文本后自检失败（旧表达式残留或新表达式缺失）；未修改任何文件。`);
}

if (args.check) {
  console.log(`[ready] ${TARGET_REL}：结构探测通过（锚点唯一、补丁文本自检通过），可执行补丁。`);
  process.exit(0);
}

const backup = file + BACKUP_SUFFIX;
if (!existsSync(backup)) copyFileSync(file, backup);
writeFileSync(file, candidate, "utf8");
if (!syntaxCheck(file)) {
  copyFileSync(backup, file);
  throw new Error(`${file} 语法校验失败，已从备份还原，请人工检查。`);
}
if (!readFileSync(file, "utf8").includes(NEW)) {
  copyFileSync(backup, file);
  throw new Error(`${file}: 落盘后自检失败（新表达式未写入），已从备份还原。`);
}
console.log(`[patched] ${TARGET_REL}（备份：${backup}）`);
console.log("完成。请重启 dsh 并刷新浏览器使改动生效。");
