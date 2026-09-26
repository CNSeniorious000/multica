// Type surface for `partial-react` (the package root, ./src/runtime.ts),
// redirected here from the views tsconfig `paths`. See partial-tsx.d.ts for
// why: partial-react ships raw .ts with no .d.ts, so tsc would type-check its
// implementation under this repo's stricter flags and fail. These declarations
// mirror the subset of partial-react@0.0.8 src/runtime.ts that the ui4a/tsx
// renderer uses. Type only — the bundler resolves the real module through the
// package `exports`.
import type { RendererImportMap } from "partial-react/import-map";

export type GeneratedComponent = unknown;

export type GenUIRenderPhase = "transform" | "compile" | "render";

export type GenUIRendererCallbacks = {
  onReady?: (component: GeneratedComponent, url?: string, code?: string) => void;
  onRendered?: (component: GeneratedComponent, code: string, serial?: number) => void;
  onError?: (error: Error, phase: GenUIRenderPhase) => void;
};

export type GenUIRendererFlushMode = "microtask" | "immediate";

export type GenUIRendererOptions = {
  importmap?: RendererImportMap;
  callbacks?: GenUIRendererCallbacks;
  compiler?: unknown;
  preserveStateOnUpdate?: boolean;
  flushMode?: GenUIRendererFlushMode;
  filename?: string;
};

export class GenUIRenderer {
  static create(
    target?: HTMLElement | null,
    options?: GenUIRendererOptions,
  ): Promise<GenUIRenderer>;
  render(code: string, serial?: number): void;
  detach(): this;
}
