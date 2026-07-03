/** Minimal typings for snappyjs (pure-JS snappy raw block codec, no upstream types). */
declare module "snappyjs" {
  interface SnappyJS {
    compress(input: Uint8Array): Uint8Array;
    compress(input: ArrayBuffer): ArrayBuffer;
    uncompress(input: Uint8Array, maxLength?: number): Uint8Array;
    uncompress(input: ArrayBuffer, maxLength?: number): ArrayBuffer;
  }
  const snappy: SnappyJS;
  export default snappy;
}
