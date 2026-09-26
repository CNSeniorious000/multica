// Browser build stub for partial-react's Node-only WASM loader. The client
// compiler never calls loadNodeWasm because it takes its bundled WASM asset
// branch, but webpack still follows the sibling dynamic import while building
// the graph.
export const loadNodeWasm = async () => {
  throw new Error("Node WASM loader is unavailable in the browser");
};
