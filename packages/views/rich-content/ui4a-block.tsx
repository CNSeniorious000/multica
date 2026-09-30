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
 * Reached from rich-code-block.tsx's RichFenceBlock for BOTH an open and a
 * closed fence. UI4A's selling point is partial rendering: while the fence
 * streams, each frame is fed to partial-react's `pushCode`, which compiles the
 * partial body through partial-tsx's streaming completer so the widget grows
 * token by token (skeleton → card → chart). When the fence closes, `finish`
 * runs the final full compile. `preserveStateOnUpdate` keeps mounted state and
 * the last good frame across partial frames, so a transiently unparseable frame
 * never blanks the panel.
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

type Renderer = Awaited<ReturnType<Ui4aRuntime["createRenderer"]>>;

function Ui4aRenderer({ code, closed }: { code: string; closed: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<RenderState>({ status: "loading" });

  // The renderer instance is created once and kept alive across `code`/`closed`
  // changes, so partial frames accumulate on ONE streaming buffer (pushCode
  // appends) and preserved state survives frame to frame. A per-`code` effect
  // would detach and recreate the renderer on every token, throwing away both.
  const rendererRef = useRef<Renderer | null>(null);
  // How much of `code` has already been fed to the renderer. pushCode takes
  // deltas (it appends), while react-markdown hands us the whole accumulated
  // body each frame, so we forward only the newly-arrived suffix.
  const pushedLengthRef = useRef(0);
  // A frame can arrive before the async renderer finishes creating; remember the
  // latest props so the creation tail can apply them once it is ready.
  const pendingRef = useRef<{ code: string; closed: boolean }>({ code, closed });

  useEffect(() => {
    let cancelled = false;

    // Feed one frame to a ready renderer: the new suffix as a partial frame while
    // the fence streams, or the full body via finish() once it closes. If the
    // body is not an append of what we already pushed (an edit or a re-key that
    // slipped past memo), reset the buffer and push the whole thing fresh.
    const applyFrame = (renderer: Renderer, nextCode: string, isClosed: boolean) => {
      if (isClosed) {
        renderer.finish(nextCode);
        pushedLengthRef.current = nextCode.length;
        return;
      }
      const pushed = pushedLengthRef.current;
      if (nextCode.length === pushed) return;
      if (nextCode.startsWith(renderer.getCurrentBuffer())) {
        renderer.pushCode(nextCode.slice(pushed));
      } else {
        renderer.clear({ preserveVisualState: true });
        renderer.pushCode(nextCode);
      }
      pushedLengthRef.current = nextCode.length;
    };

    pendingRef.current = { code, closed };

    if (rendererRef.current) {
      applyFrame(rendererRef.current, code, closed);
      return () => {
        cancelled = true;
      };
    }

    void (async () => {
      try {
        const runtime = await loadRuntime();
        if (cancelled) return;
        const target = hostRef.current;
        if (!target) return;

        // The import map is resolved from the current body; while streaming it may
        // not yet name every dependency, but partial-react re-resolves misses
        // against the esm.sh fallback, and the closed frame carries the full set.
        const importmap = await runtime.buildImportMap(pendingRef.current.code);
        if (cancelled) return;

        const renderer = await runtime.createRenderer(target, {
          importmap,
          // Streaming needs preserved state: each partial frame keeps the last
          // good render and mounted state, so a transiently unparseable frame
          // never blanks the panel and the widget grows in place.
          preserveStateOnUpdate: true,
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
          return;
        }
        rendererRef.current = renderer;
        // Apply whatever the latest frame is (props may have advanced during the
        // async create), driving the buffer from empty.
        applyFrame(renderer, pendingRef.current.code, pendingRef.current.closed);
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
    };
  }, [code, closed]);

  // Detach the renderer only when the block unmounts, not on every frame.
  useEffect(() => {
    return () => {
      rendererRef.current?.detach();
      rendererRef.current = null;
    };
  }, []);

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
  // until the first frame commits the compiled component.
  return <div ref={hostRef} className="ui4a-block my-3" data-status={state.status} />;
}

const MemoUi4aRenderer = memo(Ui4aRenderer);

/**
 * The rich leaf for a ```ui4a/tsx fence, open or closed. Wrapped in the
 * near-viewport lazy shell like the other rich leaves, so the browser-side
 * compile only runs once the block is scrolled near.
 *
 * While the fence streams (`closed` is false) the body grows every token. The
 * lazy shell's `sourceKey` is the mount-once registry identity, so it must stay
 * stable across those frames — keying it on the growing body would spam the
 * registry and never latch. The CLOSED body is the block's stable identity, so
 * only a closed fence contributes a key; an open fence relies on React keeping
 * this leaf at a stable tree position (the parent memoizes the markdown subtree,
 * so a new frame reconciles rather than remounts) to preserve the live renderer.
 */
export function Ui4aFenceBlock({ code, closed }: { code: string; closed: boolean }) {
  return (
    <LazyRichBlock
      reservedHeightPx={UI4A_BLOCK_HEIGHT_PX}
      sourceKey={closed ? code : undefined}
    >
      <MemoUi4aRenderer code={code} closed={closed} />
    </LazyRichBlock>
  );
}
