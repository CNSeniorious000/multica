// Type surface for `partial-tsx`, redirected here from the views tsconfig
// `paths` (see packages/views/tsconfig.json).
//
// partial-tsx (like partial-react) ships raw .ts rather than a built .d.ts, so
// `tsc` follows the real source and type-checks it under Multica's stricter
// flags (noUncheckedIndexedAccess), where the upstream parser code does not
// pass. The ui4a/tsx renderer only reaches partial-tsx transitively, through
// `partial-react/compiler`'s `normalizeGeneratedTsx` import — it is never used
// directly here. These declarations mirror the package's public exports exactly
// (partial-tsx@0.0.5 src/partial.ts) so the transitive import stays fully typed
// while `tsc` no longer descends into the untyped implementation. The bundler
// still resolves the real module through the package `exports` field, so this
// affects type-checking only, not what ships.
export type PartialTsxMode = "streaming" | "final";
export type PartialTsxOptions = { mode?: PartialTsxMode };
export function hasReactComponent(code: string): boolean;
export function completePartialTsx(code: string, options?: PartialTsxOptions): string;
export function normalizeGeneratedTsx(code: string, options?: PartialTsxOptions): string;
