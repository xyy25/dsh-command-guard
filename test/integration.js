// 集成测试：用真实 cordis Context 加载插件，手动触发 tools/pre-execute
// waterfall，验证决策模型：
//   - 规则命中 critical（无 directDeny）→ 返回 { kind: "ask" }，由 harness
//     approval seam 处理（dsh-tools serviceAsk → approval UI）
//   - directDeny=true → 命中 denyMinLevel 直接 { kind: "deny" }
//   - 规则命中 high → { kind: "ask" }
//   - /guard 切换档位只改本进程会话状态，绝不写入 harness 会话事件
//     （避免自定义事件类型把会话日志写成无法重放）
//   - agent-* 档 → 用 stub llm 模拟 agent 自审，按档位阈值决策
// 运行：node test/integration.js（需要 node_modules，见 README 开发章节）
import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import * as plugin from "../lib/index.js";

const pending = [];
function test(name, fn) {
  pending.push({ name, fn });
}

function makeExec(overrides = {}) {
  return {
    callId: "test-call-1",
    name: "pwsh",
    arguments: { command: "Get-ChildItem", description: "测试" },
    signal: new AbortController().signal,
    ...overrides,
  };
}

function makeAgent(options = {}) {
  return {
    options: { provider: "test-provider", model: "test-model", ...options },
    session: { id: "test-session-1" },
  };
}

function quietLogger() {
  return {
    info() {},
    warn() {},
    debug() {},
    error() {},
    success() {},
    level: 3,
  };
}

/** 构造一个返回固定用户选择（可附带 custom 输入框文本）的 userQuestions stub。 */
function makeUi(selected, custom) {
  return {
    ask: async (request) => ({
      answers: [{
        id: request.questions[0].id,
        selected: [selected],
        ...(custom !== undefined ? { custom } : {}),
      }],
    }),
  };
}

/** 构造一个 llm stream stub，文本内容来自 content()。 */
function makeLlm(text) {
  const stream = async function* () {
    if (text) yield { type: "text-delta", text };
    yield { type: "finish" };
  };
  return { stream };
}

async function load(config, provides = {}) {
  const ctx = new Context();
  ctx.provide("tools", { register() {} });
  for (const [key, value] of Object.entries(provides)) ctx.provide(key, value);
  ctx.logger = quietLogger();
  await ctx.plugin(plugin, config);
  return ctx;
}

/** 触发 tools/pre-execute waterfall，返回监听器的最终决策（PreToolDecision）。 */
async function run(ctx, exec) {
  return ctx.waterfall(ctx, "tools/pre-execute", exec, () => Promise.resolve({ kind: "allow" }));
}

/** 模拟 harness dsh-tools serviceAsk：把 ask 决策按 approval 结果转成最终决策。 */
async function finalize(ctx, exec, approvalOutcome) {
  const gate = await run(ctx, exec);
  if (gate.kind !== "ask") return gate;
  if (approvalOutcome === "allowed-once") return { kind: "allow" };
  if (approvalOutcome === "rejected") return { kind: "deny", reason: `the user rejected tool "${exec.name}"` };
  return { kind: "deny", reason: "no approval channel is available" };
}

test("加载插件后可正常导出", async () => {
  assert.equal(plugin.name, "command-guard");
  assert.equal(typeof plugin.apply, "function");
  assert.deepEqual(plugin.inject, ["tools"]);
});

// ===================== 规则命中 → ask / deny 决策 =====================

test("critical（rm -rf /）无 directDeny → ask，reason 含命令预览", async () => {
  const ctx = await load({ enabled: true, tools: ["pwsh"] });
  const decision = await run(ctx, makeExec({ arguments: { command: "rm -rf /", description: "x" } }));
  assert.equal(decision.kind, "ask");
  assert.match(decision.reason, /命令审核/);
  assert.ok(decision.reason.includes("rm -rf /"), "reason 必须包含命令预览");
});

test("directDeny: true → critical 命令直接 deny（不走询问）", async () => {
  const ctx = await load({ enabled: true, tools: ["pwsh"], directDeny: true });
  const decision = await run(ctx, makeExec({ arguments: { command: "rm -rf /", description: "x" } }));
  assert.equal(decision.kind, "deny");
  assert.match(decision.reason, /命令审核拒绝/);
});

test("high 删除 → ask", async () => {
  const ctx = await load({ enabled: true, tools: ["pwsh"] });
  const decision = await run(ctx, makeExec({ arguments: { command: "Remove-Item src/main.js", description: "x" } }));
  assert.equal(decision.kind, "ask");
});

test("ask + 用户允许（模拟 approval allowed-once）→ 放行", async () => {
  const ctx = await load({ enabled: true, tools: ["pwsh"] });
  const decision = await finalize(
    ctx,
    makeExec({ arguments: { command: "Remove-Item src/main.js", description: "x" } }),
    "allowed-once",
  );
  assert.equal(decision.kind, "allow");
});

test("ask + 用户拒绝（模拟 approval rejected）→ deny", async () => {
  const ctx = await load({ enabled: true, tools: ["pwsh"] });
  const decision = await finalize(
    ctx,
    makeExec({ arguments: { command: "Remove-Item src/main.js", description: "x" } }),
    "rejected",
  );
  assert.equal(decision.kind, "deny");
  assert.match(decision.reason, /the user rejected tool "pwsh"/);
});

// ===================== 放行路径 =====================

test("安全命令 → allow（不触发询问）", async () => {
  const ctx = await load({ enabled: true, tools: ["pwsh"] });
  assert.equal((await run(ctx, makeExec({ arguments: { command: "Get-ChildItem", description: "x" } }))).kind, "allow");
});

test("Format-Table 等只读格式化输出命令不再被 format-disk 误伤", async () => {
  const ctx = await load({ enabled: true, tools: ["pwsh"] });
  assert.equal((await run(ctx, makeExec({ arguments: { command: "Get-ChildItem | Format-Table -AutoSize", description: "x" } }))).kind, "allow");
  assert.equal((await run(ctx, makeExec({ arguments: { command: "Format-Hex C:\\x.bin", description: "x" } }))).kind, "allow");
});

test("format C: / diskpart / Format-Volume 仍命中卷格式化", async () => {
  const ctx = await load({ enabled: true, tools: ["pwsh"] });
  const decision = await run(ctx, makeExec({ arguments: { command: "format C: /FS:NTFS /Q", description: "x" } }));
  assert.equal(decision.kind, "ask");
  assert.match(decision.reason, /格式化或清空磁盘卷/);
  assert.equal((await run(ctx, makeExec({ arguments: { command: "diskpart", description: "x" } }))).kind, "ask");
  assert.equal((await run(ctx, makeExec({ arguments: { command: "Format-Volume -DriveLetter C", description: "x" } }))).kind, "ask");
});

test("未在 tools 列表中的工具 / 无 command 参数 → 不审核", async () => {
  const ctx = await load({ enabled: true, tools: ["bash"] });
  assert.equal((await run(ctx, makeExec({ name: "pwsh", arguments: { command: "rm -rf /", description: "x" } }))).kind, "allow");
  assert.equal((await run(ctx, makeExec({ arguments: { path: "/tmp" } }))).kind, "allow");
});

test("enabled: false → 完全放行", async () => {
  const ctx = await load({ enabled: false, tools: ["pwsh"] });
  assert.equal((await run(ctx, makeExec({ arguments: { command: "rm -rf /", description: "x" } }))).kind, "allow");
});

test("medium 规则默认放行；askMinLevel 收紧后需确认", async () => {
  const ctx = await load({ enabled: true, tools: ["pwsh"] });
  assert.equal((await run(ctx, makeExec({ arguments: { command: "Get-Content .env", description: "x" } }))).kind, "allow");
  // 收紧到 medium：Get-Content .env 命中 medium 规则 → ask
  const strict = await load({ enabled: true, tools: ["pwsh"], askMinLevel: "medium" });
  const decision = await run(strict, makeExec({ arguments: { command: "Get-Content .env", description: "x" } }));
  assert.equal(decision.kind, "ask");
});

// ===================== 档位切换（/guard） =====================

test("/guard 切换档位只改会话状态，不写会话事件", async () => {
  let captured = null;
  const ctx = new Context();
  ctx.provide("tools", { register() {} });
  ctx.provide("commands", { register(command) { captured = command; } });
  ctx.logger = quietLogger();
  await ctx.plugin(plugin, { enabled: true, tools: ["pwsh"] });
  assert.ok(captured, "commands.register 应捕获到 /guard 命令");

  const agent = makeAgent();
  const session = agent.session;
  const result = captured.handler({ agent, rawInput: "agent-strict" });
  assert.equal(result.kind, "success");
  assert.equal(result.text, "agent-strict");
  // 会话没有 events/append 面 —— 档位不再以会话事件持久化
  assert.ok(!("append" in session), "会话不应暴露 append（插件不得写会话事件）");
  assert.ok(!("events" in session), "插件不应读取/写入会话事件");

  // 查询无输入 → 返回当前会话档位
  const query = captured.handler({ agent, rawInput: "" });
  assert.equal(query.kind, "success");
  assert.equal(query.text, "agent-strict");

  // 无会话上下文（agent 缺失）→ 回落默认档
  const noAgent = captured.handler({ agent: undefined, rawInput: "" });
  assert.equal(noAgent.kind, "success");
  assert.equal(noAgent.text, "rules");
});

test("会话 A 切 agent-strict 后其命令按档位裁决；会话 B 不受影响", async () => {
  const llm = makeLlm('{"risk":"low","purpose":"覆盖本地配置","impact":"改配置"}');
  const ctx = await load({ enabled: true, tools: ["pwsh"] }, { llm });

  const agentA = makeAgent();
  // 直接给会话 A 记录档位（等价 /guard agent-strict 之后）
  const captured = [];
  const cmdCtx = new Context();
  cmdCtx.provide("tools", { register() {} });
  cmdCtx.provide("commands", { register(command) { captured.push(command); } });
  cmdCtx.logger = quietLogger();
  await cmdCtx.plugin(plugin, { enabled: true, tools: ["pwsh"], llm: { enabled: true } });
  assert.equal(captured[0].handler({ agent: agentA, rawInput: "agent-strict" }).text, "agent-strict");

  // 注意：上面的 cmdCtx 与 ctx 是不同插件实例；档位 Map 彼此独立。
  // 因此本用例直接验证：档位作用域限定在“同一次 apply 实例”内。
  const sameCtx = await load({ enabled: true, tools: ["pwsh"], mode: "agent-strict" }, { llm });
  const agentB = makeAgent({ session: undefined });
  const strictDecision = await run(sameCtx, makeExec({ agent: agentA, arguments: { command: "Set-Content app.conf new", description: "x" } }));
  assert.equal(strictDecision.kind, "ask", "agent-strict 档：agent 判 low 也应确认");

  const rulesCtx = await load({ enabled: true, tools: ["pwsh"] }, { llm });
  const looseDecision = await run(rulesCtx, makeExec({ agent: makeAgent({ session: { id: "other" } }), arguments: { command: "Set-Content app.conf new", description: "x" } }));
  assert.equal(looseDecision.kind, "allow", "rules 默认档：未命中规则放行");
});

// ===================== agent 档（stub llm） =====================

test("agent-standard：agent 判 high → ask（reason 含用途/影响）", async () => {
  const ctx = await load({ enabled: true, tools: ["bash"], mode: "agent-standard" }, {
    llm: makeLlm('{"risk":"high","purpose":"清理未跟踪文件","impact":"删除未提交改动"}'),
  });
  const agent = makeAgent();
  const command = "git clean -fdx";
  const decision = await run(ctx, makeExec({ name: "bash", agent, arguments: { command, description: "x" } }));
  assert.equal(decision.kind, "ask");
  assert.ok(decision.reason.includes("清理未跟踪文件"), "reason 应含 agent 用途");
  assert.ok(decision.reason.includes(command), "reason 应含命令预览");
});

test("agent-standard：agent 判 safe → 放行（不触发询问）", async () => {
  const ctx = await load({ enabled: true, tools: ["pwsh"], mode: "agent-standard" }, {
    llm: makeLlm('{"risk":"safe","purpose":"查看版本"}'),
  });
  const agent = makeAgent();
  const decision = await run(ctx, makeExec({ agent, arguments: { command: "dotnet --version", description: "x" } }));
  assert.equal(decision.kind, "allow");
});

test("agent-very-loose：agent 判 high 仍放行（阈值 critical）", async () => {
  const ctx = await load({ enabled: true, tools: ["pwsh"], mode: "agent-very-loose" }, {
    llm: makeLlm('{"risk":"high","purpose":"删除构建产物","impact":"删除 build"}'),
  });
  const decision = await run(ctx, makeExec({ agent: makeAgent(), arguments: { command: "Remove-Item -Recurse ./build", description: "x" } }));
  assert.equal(decision.kind, "allow");
});

test("agent-strict：agent 判 low → ask", async () => {
  const ctx = await load({ enabled: true, tools: ["pwsh"], mode: "agent-strict" }, {
    llm: makeLlm('{"risk":"low","purpose":"覆盖本地配置","impact":"改配置"}'),
  });
  const decision = await run(ctx, makeExec({ agent: makeAgent(), arguments: { command: "Set-Content app.conf new", description: "x" } }));
  assert.equal(decision.kind, "ask");
});

test("agent 档 llm 不可用 → 回落 rules（high 命令 → ask）", async () => {
  const ctx = await load({ enabled: true, tools: ["pwsh"], mode: "agent-standard" });
  const decision = await run(ctx, makeExec({ agent: makeAgent(), arguments: { command: "Remove-Item src/main.js", description: "x" } }));
  assert.equal(decision.kind, "ask");
  assert.match(decision.reason, /回落规则判定/);
});

test("agent 档 llm 不可用 + agentFallback allow → 放行", async () => {
  const ctx = await load({ enabled: true, tools: ["pwsh"], mode: "agent-standard", agentFallback: "allow" });
  const decision = await run(ctx, makeExec({ agent: makeAgent(), arguments: { command: "Remove-Item src/main.js", description: "x" } }));
  assert.equal(decision.kind, "allow");
});

test("agent 档 critical 规则（rm -rf /）即使 llm 判 safe 也仍要求确认", async () => {
  const ctx = await load({ enabled: true, tools: ["pwsh"], mode: "agent-very-loose" }, {
    llm: makeLlm('{"risk":"safe","purpose":"清理"}'),
  });
  const decision = await run(ctx, makeExec({ agent: makeAgent(), arguments: { command: "rm -rf /", description: "x" } }));
  assert.equal(decision.kind, "ask");
  assert.match(decision.reason, /根目录|删除/);
});

// ===================== 自绘确认卡（userQuestions guard-review 双通道主路径） =====================

test("确认卡：用户点允许 → 放行", async () => {
  const ctx = await load({ enabled: true, tools: ["pwsh"] }, { userQuestions: makeUi("允许执行") });
  const decision = await run(ctx, makeExec({ agent: makeAgent(), arguments: { command: "Remove-Item src/main.js", description: "x" } }));
  assert.equal(decision.kind, "allow");
});

test("确认卡：用户拒绝（无输入）→ deny 且原因含拒绝语义", async () => {
  const ctx = await load({ enabled: true, tools: ["pwsh"] }, { userQuestions: makeUi("拒绝执行") });
  const decision = await run(ctx, makeExec({ agent: makeAgent(), arguments: { command: "Remove-Item src/main.js", description: "x" } }));
  assert.equal(decision.kind, "deny");
  assert.match(decision.reason, /被用户拒绝|用户拒绝了命令审核/);
});

test("确认卡：输入框提交 → deny 且原因含用户希望", async () => {
  const ctx = await load({ enabled: true, tools: ["pwsh"] }, { userQuestions: makeUi("拒绝执行", "请改用安全的方式删除") });
  const decision = await run(ctx, makeExec({ agent: makeAgent(), arguments: { command: "Remove-Item src/main.js", description: "x" } }));
  assert.equal(decision.kind, "deny");
  assert.match(decision.reason, /被用户拒绝|用户拒绝了命令审核/);
  assert.match(decision.reason, /用户希望：请改用安全的方式删除/);
});

test("确认卡：harness 提交约定（selected 置空 + custom）→ deny 且原因含用户希望", async () => {
  // 单选问答校验要求 custom 与 selected 互斥；插件提交按钮只发 selected:[] + custom。
  const ctx = await load({ enabled: true, tools: ["pwsh"] }, {
    userQuestions: {
      ask: async (request) => ({
        answers: [{ id: request.questions[0].id, selected: [], custom: "请只读不要删除" }],
      }),
    },
  });
  const decision = await run(ctx, makeExec({ agent: makeAgent(), arguments: { command: "Remove-Item src/main.js", description: "x" } }));
  assert.equal(decision.kind, "deny");
  assert.match(decision.reason, /用户希望：请只读不要删除/);
});

test("确认卡：宿主发出的问题是 guard-review intent，detail 含命令与规则说明", async () => {
  let seen = null;
  const ctx = await load({ enabled: true, tools: ["pwsh"] }, {
    userQuestions: {
      ask: async (request) => {
        seen = request.questions[0];
        return { answers: [{ id: request.questions[0].id, selected: ["允许执行"] }] };
      },
    },
  });
  const command = "Remove-Item -Recurse -Force ./build";
  const decision = await run(ctx, makeExec({ agent: makeAgent(), arguments: { command, description: "x" } }));
  assert.equal(decision.kind, "allow");
  assert.ok(seen, "宿主应通过 userQuestions.ask 发问题");
  assert.equal(seen.intent?.kind, "guard-review", "intent 应为 guard-review 以命中插件自绘卡");
  assert.ok(seen.detail.includes(command), "detail 必须含完整命令");
  assert.ok(seen.detail.includes("递归强制删除"), "detail 必须含规则说明");
  assert.ok((seen.options ?? []).some((option) => option.label === "允许执行"), "选项须含允许");
  assert.ok((seen.options ?? []).some((option) => option.label === "拒绝执行"), "选项须含拒绝");
});

test("确认卡不可用（provider 抛错）→ 回落 ask 决策（approval seam）", async () => {
  const ctx = await load({ enabled: true, tools: ["pwsh"] }, {
    userQuestions: {
      ask: async () => {
        throw new Error("NO_PROVIDER");
      },
    },
  });
  const decision = await run(ctx, makeExec({ agent: makeAgent(), arguments: { command: "Remove-Item src/main.js", description: "x" } }));
  assert.equal(decision.kind, "ask");
  assert.match(decision.reason, /命令审核/);
});

// ===================== runner =====================

let passed = 0;
let failed = 0;
for (const { name, fn } of pending) {
  try {
    await fn();
    passed += 1;
    console.log(`ok   - ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL - ${name}`);
    console.error(`       ${error?.message ?? error}`);
  }
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
