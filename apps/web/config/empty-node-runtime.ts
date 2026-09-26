// Browser build stub for optional Node-only branches in partial-react. These
// imports are evaluated only by the local-package resolver / Node WASM path;
// the browser renderer uses bundled WASM and esm.sh resolution instead.
export const createRequire = () => {
  throw new Error("Node module resolver is unavailable in the browser");
};
export const readFile = async () => {
  throw new Error("Node filesystem is unavailable in the browser");
};
export const dirname = () => "/";
export const resolve = (...parts: string[]) => parts.join("/");
