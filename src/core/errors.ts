export class KeeponError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeeponError";
  }
}

export class NotSupportedError extends KeeponError {
  constructor(message: string) {
    super(message);
    this.name = "NotSupportedError";
  }
}

interface ErrorWithCause {
  cause?: unknown;
}

export const formatErrorText = (error: unknown): string => {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as ErrorWithCause).cause;
  if (cause === undefined) return error.message;
  return `${error.message}\n${formatErrorText(cause)}`;
};
