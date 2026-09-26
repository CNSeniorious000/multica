// Type surface for `partial-react/import-map`, redirected here from the views
// tsconfig `paths`. See partial-tsx.d.ts for why: partial-react ships raw .ts
// with no .d.ts, so tsc would type-check its implementation under this repo's
// stricter flags and fail. These declarations mirror the subset of
// partial-react@0.0.8 src/importMap.ts that the ui4a/tsx renderer uses. Type
// only — the bundler resolves the real module through the package `exports`.

export type RendererImportMap = {
  imports?: Record<string, string>;
  scopes?: Record<string, Record<string, string>>;
  styles?: string[];
};

export type ImportMapProviderContext = {
  code: string;
  missing: string[];
  imports?: Readonly<Record<string, string>>;
};

export type ImportMapProvider = {
  kind?: "base" | "fallback";
  prefetch?: () => Promise<unknown> | void;
  resolve: (
    context: ImportMapProviderContext,
  ) => RendererImportMap | Promise<RendererImportMap>;
};

export type ImportMapResolver = {
  prefetch: () => Promise<undefined>;
  resolve: (context?: { code?: string }) => Promise<RendererImportMap>;
};

export function literalImportMap(map: RendererImportMap): ImportMapProvider;
export function createImportMapResolver(
  providers: ImportMapProvider[],
): ImportMapResolver;
