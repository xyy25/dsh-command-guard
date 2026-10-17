// 宿主侧用到的 Node 内置模块的最小类型声明。
// 插件 tsconfig 的 `types: []` 不引入 @types/node，这里只声明实际用到的面。
declare module "node:fs" {
  export function existsSync(path: string): boolean;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function writeFileSync(path: string, data: string, encoding?: "utf8"): void;
  export function renameSync(from: string, to: string): void;
}

declare module "node:os" {
  export function homedir(): string;
}

declare module "node:path" {
  export function join(...parts: string[]): string;
  export function dirname(path: string): string;
}

/** 只用到环境变量（DSH_HOME）。 */
declare const process: {
  env: Record<string, string | undefined>;
};
