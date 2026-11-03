// hls.js ships no declarations for its light build; it has the same API as the full one.
declare module "hls.js/light" {
  export * from "hls.js";
  export { default } from "hls.js";
}
