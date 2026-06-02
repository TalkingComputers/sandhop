export const projectDirName = (cwd: string): string =>
  cwd.replace(/[^A-Za-z0-9]/g, "-");

export const safeRemoteProj = (cwd: string): { dir: string; enc: string } => ({
  dir: cwd,
  enc: projectDirName(cwd),
});
