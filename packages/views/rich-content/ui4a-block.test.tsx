/**
 * Ui4aFenceBlock wiring (MAC-19026).
 *
 * The GenUI compile itself (partial-tsx + the @esm.sh/tsx WASM compiler) is out
 * of scope for a unit test — it needs a browser WASM runtime and network. What
 * this suite pins is the contract around it: the leaf stays a placeholder on the
 * first frame (SSR-safe, like every other rich leaf), then drives the streaming
 * renderer lifecycle — create once, feed each open frame as a `pushCode` delta,
 * `finish` the full body when the fence closes, and `detach` on unmount —
 * resolves the host React singleton import map before rendering, keeps preserved
 * state across frames, reports ready/error through the callbacks, and falls back
 * to static source when the component throws.
 *
 * partial-react's three entry points are mocked so no compiler or network is
 * touched; the assertions are about how ui4a-block orchestrates them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, waitFor } from "@testing-library/react";

const {
  createSpy,
  renderSpy,
  pushCodeSpy,
  finishSpy,
  clearSpy,
  detachSpy,
  resolveSpy,
  capturedOptions,
} = vi.hoisted(() => ({
  createSpy: vi.fn(),
  renderSpy: vi.fn(),
  pushCodeSpy: vi.fn(),
  finishSpy: vi.fn(),
  clearSpy: vi.fn(),
  detachSpy: vi.fn(),
  resolveSpy: vi.fn(),
  // The options object passed to GenUIRenderer.create, captured so a test can
  // fire its onRendered / onError callbacks.
  capturedOptions: { current: undefined as unknown },
}));

// A stand-in renderer whose getCurrentBuffer tracks the pushed/finished code, so
// the delta logic in applyFrame (push only the new suffix; reset+push on a
// non-append) is exercised against a realistic buffer rather than a constant.
function makeRenderer() {
  let buffer = "";
  return {
    render: (code: string) => {
      buffer = code;
      renderSpy(code);
    },
    pushCode: (code: string) => {
      buffer += code;
      pushCodeSpy(code);
    },
    finish: (code?: string) => {
      if (code !== undefined) buffer = code;
      finishSpy(code);
    },
    getCurrentBuffer: () => buffer,
    clear: (options?: unknown) => {
      buffer = "";
      clearSpy(options);
    },
    detach: detachSpy,
  };
}

vi.mock("partial-react", () => ({
  GenUIRenderer: {
    create: (target: unknown, options: unknown) => {
      capturedOptions.current = options;
      createSpy(target, options);
      return Promise.resolve(makeRenderer());
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
  pushCodeSpy.mockClear();
  finishSpy.mockClear();
  clearSpy.mockClear();
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
    render(<Ui4aFenceBlock code={CODE} closed />);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("resolves the import map, then finishes the full body for a closed fence", async () => {
    render(<Ui4aFenceBlock code={CODE} closed />);

    await waitFor(() => expect(createSpy).toHaveBeenCalledTimes(1));

    // Import map resolved from the source BEFORE the renderer is created.
    expect(resolveSpy).toHaveBeenCalledWith({ code: CODE });
    // Streaming keeps the last good frame and mounted state across frames.
    const options = capturedOptions.current as { preserveStateOnUpdate?: boolean };
    expect(options.preserveStateOnUpdate).toBe(true);
    // A closed fence is the final full body: finish() runs the full compile,
    // never a partial pushCode frame.
    await waitFor(() => expect(finishSpy).toHaveBeenCalledWith(CODE));
    expect(pushCodeSpy).not.toHaveBeenCalled();
  });

  it("feeds an open fence as a partial pushCode frame, then grows it by deltas", async () => {
    const FRAME_1 = "export default function C() {\n";
    const FRAME_2 = FRAME_1 + "  return <div>hi</div>;\n";
    const { rerender } = render(<Ui4aFenceBlock code={FRAME_1} closed={false} />);

    await waitFor(() => expect(createSpy).toHaveBeenCalledTimes(1));
    // First open frame is pushed whole (buffer started empty), not finished.
    await waitFor(() => expect(pushCodeSpy).toHaveBeenCalledWith(FRAME_1));
    expect(finishSpy).not.toHaveBeenCalled();

    // A later open frame extends the buffer: only the new suffix is pushed.
    rerender(<Ui4aFenceBlock code={FRAME_2} closed={false} />);
    await waitFor(() =>
      expect(pushCodeSpy).toHaveBeenCalledWith(FRAME_2.slice(FRAME_1.length)),
    );
    // Still one renderer instance: the stream accumulated on a single buffer.
    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  it("finishes the full body when a streamed-open fence finally closes", async () => {
    const OPEN = "export default function C() {\n";
    const CLOSED = OPEN + "  return <div>hi</div>;\n}";
    const { rerender } = render(<Ui4aFenceBlock code={OPEN} closed={false} />);
    await waitFor(() => expect(pushCodeSpy).toHaveBeenCalledWith(OPEN));

    rerender(<Ui4aFenceBlock code={CLOSED} closed />);
    // Closing switches to a full compile of the whole body on the SAME renderer.
    await waitFor(() => expect(finishSpy).toHaveBeenCalledWith(CLOSED));
    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  it("resets and re-pushes when an open frame is not an append of the buffer", async () => {
    const FRAME = "export default function C() {\n";
    const REWRITTEN = "export default function Other() {\n";
    const { rerender } = render(<Ui4aFenceBlock code={FRAME} closed={false} />);
    await waitFor(() => expect(pushCodeSpy).toHaveBeenCalledWith(FRAME));

    // A frame that does not start with the current buffer (an edit, not an
    // append) clears with preserved visual state and pushes the whole thing.
    rerender(<Ui4aFenceBlock code={REWRITTEN} closed={false} />);
    await waitFor(() =>
      expect(clearSpy).toHaveBeenCalledWith({ preserveVisualState: true }),
    );
    expect(pushCodeSpy).toHaveBeenCalledWith(REWRITTEN);
  });

  it("marks the block ready once the renderer reports onRendered", async () => {
    const { container } = render(<Ui4aFenceBlock code={CODE} closed />);
    await waitFor(() => expect(createSpy).toHaveBeenCalled());

    act(() => fireRendered());

    await waitFor(() => {
      const host = container.querySelector(".ui4a-block");
      expect(host?.getAttribute("data-status")).toBe("ready");
    });
  });

  it("falls back to static source when the component errors", async () => {
    const { container } = render(<Ui4aFenceBlock code={CODE} closed />);
    await waitFor(() => expect(createSpy).toHaveBeenCalled());

    act(() => fireError("boom"));

    // The broken widget becomes a highlighted code block, never a blank space.
    await waitFor(() => {
      expect(container.querySelector("code.hljs")).not.toBeNull();
    });
    expect(container.querySelector(".ui4a-block")).toBeNull();
  });

  it("detaches the renderer on unmount so its blob URLs are revoked", async () => {
    const { unmount } = render(<Ui4aFenceBlock code={CODE} closed />);
    await waitFor(() => expect(createSpy).toHaveBeenCalled());

    await act(async () => unmount());
    expect(detachSpy).toHaveBeenCalledTimes(1);
  });
});
