// dsh-command-guard —— dsh 安装后处理脚本：为 harness 的 userQuestions wire schema
// 补上 guard-review intent 白名单（方案 A 的最小契约扩展）。
//
// 为什么需要：插件自绘“命令审核”确认卡依赖宿主发送 intent.kind = "guard-review"
// 的问题；而 harness 把该帧的 intent 限定为只允许 "plan-review"
// （dsh-client-connection 与 dsh-host-apiproxy 两处 zod discriminatedUnion）。
// 未知 intent 会在浏览器端解码时被整帧丢弃（控制台可见
// `dropping malformed WebSocket frame ... ZodError ... options: ["plan-review"]`），
// 表现为不弹卡、宿主 ask 挂起（转圈）。本脚本给两处 union 各追加一个
// guard-review 成员（不触碰其它逻辑；plan-review 不受影响）。
//
// 用法：
//   node tools/patch-dsh-question-intent.mjs --dsh "E:\\nvm\\v24.14.1\\node_modules\\@deepseek-ai\\dsh"
//   node tools/patch-dsh-question-intent.mjs --dsh <dsh-root> --undo   # 回滚
//
// 行为：
//   - 幂等：目标文件已含 guard-review 时跳过；
//   - 每次真实修改前先备份为 <file>.bak-intent-guard-review（不覆盖既有备份）；
//   - 完成后用 node --check 校验改动文件语法。
// 生效：重启 dsh（host 与浏览器都重新加载 bundle）。
// dsh 升级后需要重新运行本脚本（备份文件可帮助确认旧改动）。
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

/** 常见候选（按需用 --dsh 精确指定；候选仅用于减少输入）。 */
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
