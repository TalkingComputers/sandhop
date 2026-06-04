import { Buffer } from "node:buffer";

const encoder = new TextEncoder();

export const toBytes = (data: Uint8Array | string): Uint8Array =>
  typeof data === "string" ? encoder.encode(data) : new Uint8Array(data);

export const toBuffer = (data: Uint8Array | string): Buffer =>
  Buffer.from(toBytes(data));

export const toArrayBuffer = (data: Uint8Array | string): ArrayBuffer => {
  const bytes = toBytes(data);
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
};
