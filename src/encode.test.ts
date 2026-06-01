import { expect, test } from "vitest";
import { projectDirName, safeRemoteProj } from "./encode.js";

test("encodes slashes and dots to dashes", () => {
  expect(projectDirName("/Users/p/Desktop/Keepon")).toBe(
    "-Users-p-Desktop-Keepon",
  );
  expect(projectDirName("/Users/p/.hermes/agent")).toBe(
    "-Users-p--hermes-agent",
  );
  expect(projectDirName("/Users/p/My Proj_v2")).toBe("-Users-p-My-Proj-v2");
});

test("safeRemoteProj sanitizes basename and matches encoding", () => {
  const r = safeRemoteProj("/Users/p/Desktop/My Proj.v2");
  expect(r.dir).toBe("/home/user/My-Proj-v2");
  expect(r.enc).toBe("-home-user-My-Proj-v2");
});

test("safeRemoteProj falls back to 'project' for empty basename", () => {
  expect(safeRemoteProj("/").dir).toBe("/home/user/project");
});
