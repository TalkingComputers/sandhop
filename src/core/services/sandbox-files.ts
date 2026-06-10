import { quote } from "shell-quote";
import { dirname, remotePath, uniqueSorted } from "../paths.js";
import { execShell, type Sandbox } from "../ports/provider.js";
import {
  renderChownToRuntimeUser,
  renderCreateOwnedDirs,
} from "../sandbox-scripts.js";

export interface OwnedFile {
  path: string;
  content: Uint8Array | string;
  mode?: string;
}

export interface OwnedDir {
  path: string;
  mode: string;
}

export const renderPathsPrep = (paths: string[]): string =>
  [
    "set -e",
    ...renderCreateOwnedDirs(paths),
    ...renderChownToRuntimeUser(paths, true),
  ].join("\n");

export const renderPathPrep = (path: string): string => renderPathsPrep([path]);

export const uploadOwnedFiles = async (
  sandbox: Sandbox,
  files: OwnedFile[],
  ownedDirs: OwnedDir[],
): Promise<void> => {
  if (files.length === 0 && ownedDirs.length === 0) return;
  const dirs = uniqueSorted([
    ...files.map((file) => dirname(file.path)),
    ...ownedDirs.map((dir) => dir.path),
  ]);
  const prep = await execShell(sandbox, renderPathsPrep(dirs));
  if (prep.exitCode !== 0)
    throw new Error(
      `Path prep failed for ${dirs.join(", ")}: stderr=${JSON.stringify(prep.stderr)} stdout=${JSON.stringify(prep.stdout)}`,
    );
  await Promise.all(
    files.map((file) =>
      sandbox.uploadFile(remotePath(file.path), file.content),
    ),
  );
  const ownership = await execShell(
    sandbox,
    [
      "set -e",
      ...renderChownToRuntimeUser(
        files.map((file) => file.path),
        false,
      ),
      ...ownedDirs.map((dir) => `chmod ${dir.mode} ${quote([dir.path])}`),
      ...files.flatMap((file) =>
        file.mode === undefined
          ? []
          : [`chmod ${file.mode} ${quote([file.path])}`],
      ),
    ].join("\n"),
  );
  if (ownership.exitCode !== 0)
    throw new Error(
      `Path ownership failed for ${files
        .map((file) => file.path)
        .join(
          ", ",
        )}: stderr=${JSON.stringify(ownership.stderr)} stdout=${JSON.stringify(ownership.stdout)}`,
    );
};
