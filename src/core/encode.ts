export const projectDirName = (cwd: string): string =>
  cwd.replace(/[^A-Za-z0-9]/g, "-");
