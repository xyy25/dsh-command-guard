// 浏览器端 client bundle 依赖的第三方模块类型声明。
// 运行时由 dsh-client-modules 的模块系统以 require(specifier) 提供；
// 仓库内没有这些包的 .d.ts，故在此做宽松声明（仅服务编译期）。

declare module "react" {
  export const useState: <S>(initial: S | (() => S)) => [S, (value: S | ((prev: S) => S)) => void];
  export const useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => void;
  export const useMemo: <T>(factory: () => T, deps?: readonly unknown[]) => T;
  export const useRef: <T>(initial: T) => { current: T };
  export const createElement: (...args: any[]) => any;
  export const Fragment: any;
}

declare module "@deepseek-ai/dsh-client-ui-primitives" {
  export const Menu: any;
  export const Button: any;
  export const IconChevronDownOutline14: any;
  export const MarkdownText: any;
}

declare module "@deepseek-ai/dsh-client-runtime/client" {
  export interface SnapshotStore<T> {
    getSnapshot(): T;
    update(mutate: (draft: T) => void): void;
  }
  export function createSnapshotStore<T extends object>(initial: T): SnapshotStore<T>;
}

declare module "@deepseek-ai/dsh-client-ui-user-questions" {
  export class PendingQuestion {
    constructor(wait: any);
    readonly key: string;
    readonly questions: any[];
    answer(answer: any): Promise<void>;
    cancel(): Promise<void>;
  }
}
