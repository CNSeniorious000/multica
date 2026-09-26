"use client";

/**
 * Ui4aFenceBlock — GenUI renderer for closed ```ui4a/tsx fences (MAC-19026).
 *
 * A ui4a/tsx fence holds a self-contained React/TSX component that the model
 * emitted. This leaf compiles that TSX in the browser (via partial-tsx +
 * partial-react's @esm.sh/tsx WASM compiler), loads the result as a blob
 * module, and mounts it — so a chat message, an issue description, a comment,
 * or an agent trajectory round can carry a live GenUI widget.
 *
 * Reached ONLY from rich-code-block.tsx's RichFenceBlock, and only for a CLOSED
 * fence (see streaming-fence.ts) — a half-streamed fence renders as plain
 * source, so the compiler never parses a partial component.
 *
 * Everything heavy is lazy. The partial-react/partial-tsx libraries and the
 * host React namespaces are pulled through dynamic import() inside an effect
 * (mirroring editor/mermaid-diagram.tsx's getMermaid), so nothing lands in the
 * main bundle and nothing runs on the server — the surrounding LazyRichBlock
 * already defers this leaf until it is near the viewport.
 *
 * React singleton bridge: a compiled blob module's `import ... from "react"`
 * (and jsx-runtime, react-dom, scheduler) must resolve to the SAME React
 * instance the host page runs, or hooks throw "invalid hook call". A blob URL
 * has no package resolution of its own, so we expose the host module namespaces
 * on a globalThis registry and hand the compiler an import map whose entries are
 * tiny blob shims that re-export from that registry. Transitive npm deps the
 * component pulls fall back to esm.sh with React externalized (so they reuse the
 * host instance too).
 */

import { memo, useEffect, useRef, useState } from "react";
import type { RendererImportMap } from "partial-react/import-map";
import { StaticCodeBody } from "./rich-code-block";
import { LazyRichBlock } from "./lazy-rich-block";

/**
 * Reserved height for the lazy shell before the widget mounts. GenUI output has
 * no cacheable natural height (unlike a Mermaid diagram), so this is a plain
 * skeleton default sized to hold a typical card without excessive empty space.
 */
export const UI4A_BLOCK_HEIGHT_PX = 320;

// ---------------------------------------------------------------------------
// Host React singleton bridge
// ---------------------------------------------------------------------------
//
// Reimplemented locally (~30 lines) rather than pulled from a package: this
// bridge is the one piece partial-react intentionally leaves to the host, since
// only the host knows which React instance its blob modules must share.

const HOST_MODULES_KEY = Symbol.for("multica.ui4a.host-modules");
// A valid JS export binding name; keys that are not (Symbols never reach
// Object.keys, but be defensive) are skipped so the shim stays syntactically valid.
const EXPORT_NAME = /^[A-Za-z_$][\w$]*$/;

type ModuleObject = Record<string, unknown>;

function hostModules(): Map<string, ModuleObject> {
  const store = globalThis as unknown as {
    [HOST_MODULES_KEY]?: Map<string, ModuleObject>;
  };
  return (store[HOST_MODULES_KEY] ??= new Map());
}

/**
 * Flatten a module namespace into one object whose keys are all safe to
 * re-export. A CJS package reached through `import * as` may surface its members
 * only under `default` (interop), so merge default's members with the
 * namespace's own named exports.
 */
function toModuleObject(namespace: unknown): ModuleObject {
  const ns = namespace as ModuleObject;
  const base = ns && typeof ns === "object" ? (ns.default as ModuleObject | undefined) : undefined;
  return base && typeof base === "object" ? { ...base, ...ns } : ns;
}

/**
 * Source of a blob shim module: it reads the host module object back off the
 * registry by id and re-exports each member, so the compiled component links
 * against the real host instance instead of a fresh copy.
 */
function moduleShimSource(id: string, moduleObject: ModuleObject): string {
  const names = Object.keys(moduleObject).filter(
    (name) => name !== "default" && EXPORT_NAME.test(name),
  );
  return [
    `const ns = globalThis[Symbol.for(${JSON.stringify(HOST_MODULES_KEY.description)})].get(${JSON.stringify(id)});`,
    ...names.map((name) => `export const ${name} = ns[${JSON.stringify(name)}];`),
    "export default ns.default ?? ns;",
  ].join("\n");
}

/**
 * Register host module namespaces and return an import-map `imports` block
 * mapping each specifier to a blob shim that re-exports it. Page-global and
 * built once — the shims live for the page lifetime, so there is no dispose.
 */
function createHostModuleImports(
  modules: Record<string, unknown>,
): Record<string, string> {
  const registry = hostModules();
  const imports: Record<string, string> = {};
  for (const [specifier, namespace] of Object.entries(modules)) {
    const id = `${specifier}\u0000${crypto.randomUUID()}`;
    const moduleObject = toModuleObject(namespace);
    registry.set(id, moduleObject);
    imports[specifier] = URL.createObjectURL(
      new Blob([moduleShimSource(id, moduleObject)], { type: "text/javascript" }),
    );
  }
  return imports;
}

// ---------------------------------------------------------------------------
// Lazy runtime
// ---------------------------------------------------------------------------
//
// The renderer, its compiler and the host React namespaces are loaded once,
// on first mount of any ui4a block, and shared across every block afterwards.

type GenUIRendererModule = typeof import("partial-react");
type ImportMapModule = typeof import("partial-react/import-map");
type RemoteModule = typeof import("partial-react/remote-module");

type Ui4aRuntime = {
  createRenderer: GenUIRendererModule["GenUIRenderer"]["create"];
  buildImportMap: (code: string) => Promise<RendererImportMap>;
};

let runtimePromise: Promise<Ui4aRuntime> | null = null;

async function loadRuntime(): Promise<Ui4aRuntime> {
  runtimePromise ??= (async () => {
    // Namespace imports so a CJS interop default and the named exports both
    // reach the registry. These resolve to the host's own installed React.
    const [runtime, importMap, remoteModule, React, ReactDom, ReactDomClient, JsxRuntime, JsxDevRuntime, Scheduler] =
      await Promise.all([
        import("partial-react"),
        import("partial-react/import-map"),
        import("partial-react/remote-module"),
        import("react"),
        import("react-dom"),
        import("react-dom/client"),
        import("react/jsx-runtime"),
        import("react/jsx-dev-runtime"),
        import("scheduler"),
      ]);

    const hostImports = createHostModuleImports({
      react: React,
      "react-dom": ReactDom,
      "react-dom/client": ReactDomClient,
      "react/jsx-runtime": JsxRuntime,
      "react/jsx-dev-runtime": JsxDevRuntime,
      scheduler: Scheduler,
    });

    const resolver = (importMap as ImportMapModule).createImportMapResolver([
      // Host React first: these specifiers must never reach esm.sh, or a second
      // React instance would break hooks.
      (importMap as ImportMapModule).literalImportMap({ imports: hostImports }),
      // Everything else the component imports (npm deps) falls back to esm.sh
      // with React externalized, so it links against the same host instance.
      (remoteModule as RemoteModule).transformedEsmShFallback({}),
    ]);

    return {
      createRenderer: (runtime as GenUIRendererModule).GenUIRenderer.create,
      buildImportMap: (code: string) => resolver.resolve({ code }),
    } satisfies Ui4aRuntime;
  })().catch((error) => {
    // Let a later mount retry rather than pinning the rejection for the page.
    runtimePromise = null;
    throw error;
  });
  return runtimePromise;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type RenderState =
  | { status: "loading" }
  | { status: "ready" }
  | { status: "error"; message: string };

function Ui4aRenderer({ code }: { code: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<RenderState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    // The renderer owns its own React root inside `target`; keep a handle so the
    // cleanup can detach it (unmount + revoke the blob module URLs).
    type Renderer = Awaited<ReturnType<Ui4aRuntime["createRenderer"]>>;
    let renderer: Renderer | null = null;

    void (async () => {
      try {
        const runtime = await loadRuntime();
        if (cancelled) return;
        const target = hostRef.current;
        if (!target) return;

        const importmap = await runtime.buildImportMap(code);
        if (cancelled) return;

        renderer = await runtime.createRenderer(target, {
          importmap,
          // A closed fence is a complete component: no state to preserve across
          // stream frames, and a single render() is the whole lifecycle.
          preserveStateOnUpdate: false,
          callbacks: {
            onRendered: () => {
              if (!cancelled) setState({ status: "ready" });
            },
            onError: (error) => {
              if (!cancelled) setState({ status: "error", message: error.message });
            },
          },
        });
        if (cancelled) {
          renderer.detach();
          renderer = null;
          return;
        }
        renderer.render(code);
      } catch (error) {
        if (!cancelled) {
          setState({
            status: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    })();

    return () => {
      cancelled = true;
      renderer?.detach();
    };
  }, [code]);

  // On failure, fall back to the source as a normal highlighted code block, so a
  // broken component is never a blank space.
  if (state.status === "error") {
    return (
      <div className="code-block-wrapper my-3">
        <pre className="!m-0">
          <StaticCodeBody language="tsx" body={code} />
        </pre>
      </div>
    );
  }

  // The renderer mounts its own subtree into this host node. It stays empty
  // until the effect commits the compiled component.
  return <div ref={hostRef} className="ui4a-block my-3" data-status={state.status} />;
}

const MemoUi4aRenderer = memo(Ui4aRenderer);

/**
 * The rich leaf for a closed ```ui4a/tsx fence. Wrapped in the near-viewport
 * lazy shell like the other rich leaves, so the browser-side compile only runs
 * once the block is scrolled near.
 */
export function Ui4aFenceBlock({ code }: { code: string }) {
  return (
    <LazyRichBlock reservedHeightPx={UI4A_BLOCK_HEIGHT_PX} sourceKey={code}>
      <MemoUi4aRenderer code={code} />
    </LazyRichBlock>
  );
}
