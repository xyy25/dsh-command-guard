// dsh-command-guard —— typert host manifest。
//
// 说明：官方用构建期的 @deepseek-ai/dsh-typert-generator 生成这份文件；本仓库
// （手写 tsc 构建）没有生成链，因此这里按 Frozen manifest 结构手写，字段与
// @deepseek-ai/dsh-permission-presets 的产物保持一致，并由
// dsh-typert-loader 在校验（validateTypertManifest）后注册。
//
// 作用：把"查询某会话的审核档位"暴露成只读远程方法，客户端通过
//   ctx.inject(["remote.commandGuard"], ...) → ctx.remote.commandGuard.sessionMode(id)
// 读取，**不写任何会话事件**（区别于执行 /guard 命令）。
import { z } from "zod";

/** 返回值 schema：解析后的档位 + 来源（session / inherited / default 之一）。 */
const sessionModeResultSchema = () =>
  z.object({
    mode: z.string(),
    source: z.string(),
    parent: z.string().optional(),
  });

export const TYPERT = {
  package: "dsh-command-guard",
  face: "host",
  schemas: [],
  invocations: [
    {
      id: "dsh-command-guard#commandGuard/sessionMode",
      service: "commandGuard",
      namespace: "commandGuard",
      method: "sessionMode",
      invocation: { kind: "direct" },
      parameters: [
        {
          name: "sessionId",
          wire: "sessionId",
          source: "json",
          codec: { mode: "strict", typeSymbol: "dsh-command-guard#SessionId", create: () => z.string() },
        },
      ],
      result: {
        mode: "strict",
        typeSymbol: "dsh-command-guard#SessionModeResult",
        create: sessionModeResultSchema,
      },
      sourceLocation: { file: "src/index.ts", line: 1, column: 1 },
    },
  ],
  model: {
    services: [
      {
        key: "commandGuard",
        exportName: "CommandGuardService",
        description: "Session-scoped command review mode, exposed read-only for the client.",
        summary: "Session-scoped command review mode.",
        tags: [],
        jsDoc: "/**\n * Session-scoped command review mode, exposed read-only for the client.\n */",
        members: [
          {
            kind: "method",
            name: "sessionMode",
            signature: "sessionMode(sessionId: string): { mode: string; source: string }",
            summary: "Resolve the effective review mode of one session (session value, inherited parent, or default).",
            jsDoc: "/**\n * Resolve the effective review mode of one session.\n */",
          },
        ],
        types: [],
      },
    ],
    events: [],
    objects: [],
  },
};

export default TYPERT;
