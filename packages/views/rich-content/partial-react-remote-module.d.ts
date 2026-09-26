// Type surface for `partial-react/remote-module`, redirected here from the views
// tsconfig `paths`. See partial-tsx.d.ts for why: partial-react ships raw .ts
// with no .d.ts, so tsc would type-check its implementation under this repo's
// stricter flags and fail. These declarations mirror the subset of
// partial-react@0.0.8 src/remoteModule.ts that the ui4a/tsx renderer uses. Type
// only — the bundler resolves the real module through the package `exports`.
import type { ImportMapProvider } from "partial-react/import-map";

export type EsmShModuleResolver = (
  url: string,
  imports: Readonly<Record<string, string>>,
) => Promise<string>;

export function transformedEsmShFallback(options?: {
  dev?: boolean;
  dependencyRanges?: Readonly<Record<string, string>>;
  baseUrl?: string;
  hasLocalPackage?: (packageName: string) => Promise<boolean>;
  resolveEsmSh?: EsmShModuleResolver;
  compiler?: unknown;
  fetch?: (url: string) => Promise<unknown>;
  preload?: (url: string) => Promise<unknown> | unknown;
}): ImportMapProvider;
