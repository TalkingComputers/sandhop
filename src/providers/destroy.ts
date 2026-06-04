export const destroyOrFalse = async (
  isNotFound: (error: unknown) => boolean,
  run: () => Promise<void>,
): Promise<boolean> => {
  try {
    await run();
    return true;
  } catch (error: unknown) {
    if (isNotFound(error)) return false;
    throw error;
  }
};
