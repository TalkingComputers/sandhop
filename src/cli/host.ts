import { NodeHost } from "../host/node.js";

export const buildHost = (): NodeHost => {
  const home = process.env["HOME"];
  if (home === undefined) throw new Error("HOME is required");
  return new NodeHost(process.env, home);
};
