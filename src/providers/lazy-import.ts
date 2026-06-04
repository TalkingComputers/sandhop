import { formatErrorText } from "../core/errors.js";

const isModuleNotFound = (error: unknown, pkg: string): boolean => {
  const text = formatErrorText(error);
  return (
    text.includes(`Cannot find package '${pkg}'`) ||
    text.includes(`Cannot find package "${pkg}"`) ||
    text.includes(`Cannot find module '${pkg}'`) ||
    text.includes(`Cannot find module "${pkg}"`)
  );
};

export const lazyImport = async <T>(pkg: string, hint: string): Promise<T> => {
  try {
    return (await import(pkg)) as T;
  } catch (error: unknown) {
    if (isModuleNotFound(error, pkg)) throw new Error(hint);
    throw error;
  }
};
