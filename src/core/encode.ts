export const projectDirName = (cwd: string): string =>
  cwd.replace(/[^A-Za-z0-9]/g, "-");

export const safeRemoteProj = (cwd: string): { dir: string; enc: string } => {
  const base = cwd.split("/").filter(Boolean).pop() ?? "";
  const safe = base.replace(/[^A-Za-z0-9-]/g, "-") || "project";
  const dir = `/home/user/${safe}`;
  return { dir, enc: projectDirName(dir) };
};
