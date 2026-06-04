interface ErrorWithCause {
  cause?: unknown;
}

export const formatErrorText = (error: unknown): string => {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as ErrorWithCause).cause;
  if (cause === undefined) return error.message;
  return `${error.message}\n${formatErrorText(cause)}`;
};

export const formatErrorStack = (error: unknown): string =>
  error instanceof Error ? (error.stack ?? error.message) : String(error);
