export const collectEnvRefs = (text: string): string[] =>
  [
    ...text.matchAll(
      /(?:\$\{([A-Z][A-Z0-9_]*)\}|\$([A-Z][A-Z0-9_]*)|process\.env\.([A-Z][A-Z0-9_]*))/g,
    ),
  ]
    .map((match) => match[1] ?? match[2] ?? match[3])
    .filter((name): name is string => name !== undefined);
