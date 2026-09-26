/**
 * Ui4aFenceBlock wiring (MAC-19026).
 *
 * The GenUI compile itself (partial-tsx + the @esm.sh/tsx WASM compiler) is out
 * of scope for a unit test — it needs a browser WASM runtime and network. What
 * this suite pins is the contract around it: the leaf stays a placeholder on the
 * first frame (SSR-safe, like every other rich leaf), then drives the renderer
 * lifecycle create -> render(code) -> detach, resolves the host React singleton
 * import map before rendering, reports ready/error through the callbacks, and
 * falls back to static source when the component throws.
 *
 * partial-react's three entry points are mocked so no compiler or network is
 * touched; the assertions are about how ui4a-block orchestrates them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, waitFor } from "@testing-library/react";

const { createSpy, renderSpy, detachSpy, resolveSpy, capturedOptions } =
  vi.hoisted(() => ({
    createSpy: vi.fn(),
    renderSpy: vi.fn(),
    detachSpy: vi.fn(),
    resolveSpy: vi.fn(),
    // The options object passed to GenUIRenderer.create, captured so a test can
    // fire its onRendered / onError callbacks.
    capturedOptions: { current: undefined as unknown },
  }));

vi.mock("partial-react", () => ({
  GenUIRenderer: {
    create: (target: unknown, options: unknown) => {
      capturedOptions.current = options;
      createSpy(target, options);
      return Promise.resolve({ render: renderSpy, detach: detachSpy });
    },
  },
}));

vi.mock("partial-react/import-map", () => ({
  // The resolver chain is exercised only enough to prove ui4a-block builds it
  // from [host singletons, esm.sh fallback] and resolves before rendering.
  createImportMapResolver: () => ({ resolve: resolveSpy }),
  literalImportMap: (map: unknown) => ({ kind: "literal", map }),
}));

vi.mock("partial-react/remote-module", () => ({
  transformedEsmShFallback: () => ({ kind: "fallback" }),
}));

import { Ui4aFenceBlock } from "./ui4a-block";
import { resetMountedBlocks } from "./mounted-block-registry";

const CODE = "export default () => <div>hello genui</div>;";

beforeEach(() => {
  resetMountedBlocks();
  createSpy.mockClear();
  renderSpy.mockClear();
  detachSpy.mockClear();
  resolveSpy.mockReset();
  resolveSpy.mockResolvedValue({ imports: {} });
  capturedOptions.current = undefined;
  // jsdom implements neither of these; the host bridge builds blob shims and
  // the renderer would otherwise never be reachable under test.
  vi.stubGlobal("IntersectionObserver", undefined);
  URL.createObjectURL = vi.fn(() => "blob:ui4a-test");
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function fireRendered() {
  const options = capturedOptions.current as
    | { callbacks?: { onRendered?: () => void } }
    | undefined;
  options?.callbacks?.onRendered?.();
}

function fireError(message: string) {
  const options = capturedOptions.current as
    | { callbacks?: { onError?: (error: Error) => void } }
    | undefined;
  options?.callbacks?.onError?.(new Error(message));
}

describe("Ui4aFenceBlock", () => {
  it("shows the lazy placeholder before the block is mounted, never on the server path", () => {
    // Server render (renderToString) would take the placeholder branch too, but
    // the cheap proof is the first client frame: the effect that mounts the
    // renderer has not run yet, so no renderer is created synchronously.
    render(<Ui4aFenceBlock code={CODE} />);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("resolves the import map, then creates and renders the closed source", async () => {
    render(<Ui4aFenceBlock code={CODE} />);

    await waitFor(() => expect(createSpy).toHaveBeenCalledTimes(1));

    // Import map resolved from the source BEFORE the renderer is created.
    expect(resolveSpy).toHaveBeenCalledWith({ code: CODE });
    // A closed fence is a whole component: no cross-frame state to preserve.
    const options = capturedOptions.current as { preserveStateOnUpdate?: boolean };
    expect(options.preserveStateOnUpdate).toBe(false);
    // The exact closed source is what gets rendered.
    await waitFor(() => expect(renderSpy).toHaveBeenCalledWith(CODE));
  });

  it("marks the block ready once the renderer reports onRendered", async () => {
    const { container } = render(<Ui4aFenceBlock code={CODE} />);
    await waitFor(() => expect(createSpy).toHaveBeenCalled());

    act(() => fireRendered());

    await waitFor(() => {
      const host = container.querySelector(".ui4a-block");
      expect(host?.getAttribute("data-status")).toBe("ready");
    });
  });

  it("falls back to static source when the component errors", async () => {
    const { container } = render(<Ui4aFenceBlock code={CODE} />);
    await waitFor(() => expect(createSpy).toHaveBeenCalled());

    act(() => fireError("boom"));

    // The broken widget becomes a highlighted code block, never a blank space.
    await waitFor(() => {
      expect(container.querySelector("code.hljs")).not.toBeNull();
    });
    expect(container.querySelector(".ui4a-block")).toBeNull();
  });

  it("detaches the renderer on unmount so its blob URLs are revoked", async () => {
    const { unmount } = render(<Ui4aFenceBlock code={CODE} />);
    await waitFor(() => expect(createSpy).toHaveBeenCalled());

    await act(async () => unmount());
    expect(detachSpy).toHaveBeenCalledTimes(1);
  });
});
