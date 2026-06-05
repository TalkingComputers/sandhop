import { homedir } from "node:os";
import { NodeHost } from "../host/node.js";

export const buildHost = (): NodeHost => {
  if (process.platform === "win32")
    throw new Error(
      "sandhop requires a POSIX environment (macOS/Linux). On Windows, run it under WSL.",
    );
  return new NodeHost(process.env, homedir());
};
