// 集成测试：用真实 cordis Context 加载插件，手动触发 tools/pre-execute
// waterfall，验证新决策模型：
//   - 无 userQuestions provider（或非 root 上下文）→ 风险命令 fail closed deny
//   - 有 userQuestions provider → UI 确认卡片；允许=放行，拒绝=deny
//   - directDeny=true → 命中 denyMinLevel 直接拒绝（不弹卡）
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

function makeAgent(events = [], options = {}) {
  return {
    options: { provider: "test-provider", model: "test-model", ...options },
    session: { events: [...events] },
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

/** 构造一个返回固定用户选择的 userQuestions stub。 */
function makeUi(selected) {
  return {
    ask: async (request) => ({
      answers: [{ id: request.questions[0].id, selected: [selected] }],
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

async function run(ctx, exec) {
  return ctx.waterfall(ctx, "tools/pre-execute", exec, () => Promise.resolve({ kind: "allow" }));
}

test("加载插件后可正常导出", async () => {
  assert.equal(plugin.name, "command-guard");
  assert.equal(typeof plugin.apply, "function");
  assert.deepEqual(plugin.inject, ["tools"]);
});

// ===================== fail closed：无 UI provider =====================

test("无 userQuestions：critical 命令 fail closed deny", async () => {
  const ctx = await load({ enabled: true, tools: ["pwsh"] });
  const decision = await run(ctx, makeExec({ arguments: { command: "rm -rf /", description: "x" } }));
  assert.equal(decision.kind, "deny");
  assert.match(decision.reason, /未能获得确认|命令审核/);
});

test("无 userQuestions：high 命令 fail closed deny", async () => {
  const ctx = await load({ enabled: true, tools: ["pwsh"] });
  const decision = await run(ctx, makeExec({ arguments: { command: "Remove-Item src/main.js", description: "x" } }));
  assert.equal(decision.kind, "deny");
  assert.match(decision.reason, /未能获得确认/);
});

test("directDeny: true → critical 命令直接拒绝（不询问）", async () => {
  const ctx = await load({
    enabled: true,
    tools: ["pwsh"],
    directDeny: true,
  }, { userQuestions: makeUi("拒绝执行") });
  const decision = await run(ctx, makeExec({ arguments: { command: "rm -rf /", description: "x" } }));
  assert.equal(decision.kind, "deny");
  assert.match(decision.reason, /命令审核拒绝/);
});

// ===================== 有 UI provider：允许 / 拒绝 =====================

test("high 命令 + 用户允许 → 放行", async () => {
  const ctx = await load({ enabled: true, tools: ["pwsh"] }, {
    userQuestions: makeUi("允许执行"),
  });
  const exec = makeExec({
    agent: makeAgent(),
    arguments: { command: "Remove-Item src/main.js", description: "x" },
  });
  const decision = await run(ctx, exec);
  assert.equal(decision.kind, "allow");
});

test("high 命令 + 用户拒绝 → deny（原因含完整说明入口）", async () => {
  const ctx = await load({ enabled: true, tools: ["pwsh"] }, {
    userQuestions: makeUi("拒绝执行"),
  });
  const exec = makeExec({
    agent: makeAgent(),
    arguments: { command: "Remove-Item src/main.js", description: "x" },
  });
  const decision = await run(ctx, exec);
  assert.equal(decision.kind, "deny");
  assert.match(decision.reason, /被用户拒绝/);
});

test("确认卡片 detail 包含完整命令与规则说明", async () => {
  let seenDetail = null;
  const ui = {
    ask: async (request) => {
      seenDetail = request.questions[0].detail;
      return { answers: [{ id: request.questions[0].id, selected: ["允许执行"] }] };
    },
  };
  const ctx = await load({ enabled: true, tools: ["pwsh"] }, { userQuestions: ui });
  const command = "Remove-Item -Recurse -Force ./build";
  const decision = await run(ctx, makeExec({
    agent: makeAgent(),
    arguments: { command, description: "x" },
  }));
  assert.equal(decision.kind, "allow");
  assert.ok(seenDetail.includes(command), "detail 必须包含完整命令");
  assert.ok(seenDetail.includes("递归强制删除"), "detail 必须包含规则说明");
});

test("安全命令 → allow（不触发 UI）", async () => {
  let asked = false;
  const ui = {
    ask: async () => {
      asked = true;
      return { answers: [] };
    },
  };
  const ctx = await load({ enabled: true, tools: ["pwsh"] }, { userQuestions: ui });
  const decision = await run(ctx, makeExec({
    agent: makeAgent(),
    arguments: { command: "Get-ChildItem", description: "x" },
  }));
  assert.equal(decision.kind, "allow");
  assert.equal(asked, false);
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
  const ctx = await load({ enabled: true, tools: ["pwsh"] }, { userQuestions: makeUi("允许执行") });
  assert.equal((await run(ctx, makeExec({ agent: makeAgent(), arguments: { command: "Get-Content .env", description: "x" } }))).kind, "allow");
  // 收紧到 medium：Get-Content .env 命中 medium 规则 → 弹卡；用户拒绝 → deny
  const strict = await load({ enabled: true, tools: ["pwsh"], askMinLevel: "medium" }, { userQuestions: makeUi("拒绝执行") });
  const decision = await run(strict, makeExec({ agent: makeAgent(), arguments: { command: "Get-Content .env", description: "x" } }));
  assert.equal(decision.kind, "deny");
});

test("会话事件可切换档位", async () => {
  // events 中最近一条 command-guard/mode 决定档位（agent-standard）
  const ctx = await load({ enabled: true, tools: ["pwsh"] }, { userQuestions: makeUi("允许执行") });
  const agent = makeAgent([
    { type: "command-guard/mode", data: { mode: "agent-standard" } },
  ]);
  // 安全命令无 llm 需求也直接放行（agent 模式白名单/规则在规则层已 allow）
  assert.equal((await run(ctx, makeExec({ agent, arguments: { command: "git status", description: "x" } }))).kind, "allow");
});

// ===================== agent 档（stub llm） =====================

test("agent-standard：agent 判 high → UI 确认（允许放行 / 拒绝 deny）", async () => {
  const llm = makeLlm('{"risk":"high","purpose":"清理未跟踪文件","impact":"删除未提交改动"}');
  const agent = makeAgent([{ type: "command-guard/mode", data: { mode: "agent-standard" } }]);
  const command = "git clean -fdx";

  const allowCtx = await load({ enabled: true, tools: ["bash"] }, { userQuestions: makeUi("允许执行"), llm });
  assert.equal((await run(allowCtx, makeExec({ name: "bash", agent, arguments: { command, description: "x" } }))).kind, "allow");

  const denyCtx = await load({ enabled: true, tools: ["bash"] }, { userQuestions: makeUi("拒绝执行"), llm });
  const decision = await run(denyCtx, makeExec({ name: "bash", agent, arguments: { command, description: "x" } }));
  assert.equal(decision.kind, "deny");
  assert.match(decision.reason, /被用户拒绝/);
});

test("agent-standard：agent 判 safe → 放行（不触发 UI）", async () => {
  let asked = false;
  const ctx = await load({ enabled: true, tools: ["pwsh"] }, {
    userQuestions: {
      ask: async () => {
        asked = true;
        return { answers: [] };
      },
    },
    llm: makeLlm('{"risk":"safe","purpose":"查看版本"}'),
  });
  const agent = makeAgent([{ type: "command-guard/mode", data: { mode: "agent-standard" } }]);
  const decision = await run(ctx, makeExec({ agent, arguments: { command: "dotnet --version", description: "x" } }));
  assert.equal(decision.kind, "allow");
  assert.equal(asked, false);
});

test("agent-very-loose：agent 判 high 仍放行（阈值 critical）", async () => {
  const ctx = await load({ enabled: true, tools: ["pwsh"] }, {
    userQuestions: makeUi("允许执行"),
    llm: makeLlm('{"risk":"high","purpose":"删除构建产物","impact":"删除 build"}'),
  });
  const agent = makeAgent([{ type: "command-guard/mode", data: { mode: "agent-very-loose" } }]);
  const decision = await run(ctx, makeExec({ agent, arguments: { command: "Remove-Item -Recurse ./build", description: "x" } }));
  assert.equal(decision.kind, "allow");
});

test("agent-strict：agent 判 low → 需确认", async () => {
  const ctx = await load({ enabled: true, tools: ["pwsh"] }, {
    userQuestions: makeUi("允许执行"),
    llm: makeLlm('{"risk":"low","purpose":"覆盖本地配置","impact":"改配置"}'),
  });
  const agent = makeAgent([{ type: "command-guard/mode", data: { mode: "agent-strict" } }]);
  const decision = await run(ctx, makeExec({ agent, arguments: { command: "Set-Content app.conf new", description: "x" } }));
  assert.equal(decision.kind, "allow"); // 用户允许
});

test("agent 档卡片含 agent 的用途/影响", async () => {
  let seenDetail = null;
  const ctx = await load({ enabled: true, tools: ["pwsh"] }, {
    userQuestions: {
      ask: async (request) => {
        seenDetail = request.questions[0].detail;
        return { answers: [{ id: request.questions[0].id, selected: ["允许执行"] }] };
      },
    },
    llm: makeLlm('{"risk":"high","purpose":"递归清理临时目录","impact":"目录内容将被删除"}'),
  });
  const agent = makeAgent([{ type: "command-guard/mode", data: { mode: "agent-standard" } }]);
  const command = "Remove-Item -Recurse -Force $env:TEMP\\x";
  await run(ctx, makeExec({ agent, arguments: { command, description: "x" } }));
  assert.ok(seenDetail.includes(command), "detail 含完整命令");
  assert.ok(seenDetail.includes("用途：递归清理临时目录"));
  assert.ok(seenDetail.includes("影响：目录内容将被删除"));
});

test("agent 档 llm 不可用 → 回落规则（high 命令仍需确认）", async () => {
  // 不提供 llm 服务 → reviewByAgent undefined → agentFallback rules → high 命中 → UI → 无 UI → deny
  const ctx = await load({ enabled: true, tools: ["pwsh"] });
  const agent = makeAgent([{ type: "command-guard/mode", data: { mode: "agent-standard" } }]);
  const decision = await run(ctx, makeExec({ agent, arguments: { command: "Remove-Item src/main.js", description: "x" } }));
  assert.equal(decision.kind, "deny");
  assert.match(decision.reason, /未能获得确认/);
});

test("agent 档 llm 不可用 + agentFallback allow → 放行", async () => {
  const ctx = await load({ enabled: true, tools: ["pwsh"], agentFallback: "allow" });
  const agent = makeAgent([{ type: "command-guard/mode", data: { mode: "agent-standard" } }]);
  const decision = await run(ctx, makeExec({ agent, arguments: { command: "Remove-Item src/main.js", description: "x" } }));
  assert.equal(decision.kind, "allow");
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
