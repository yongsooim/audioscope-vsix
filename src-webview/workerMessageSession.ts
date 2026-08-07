export function isCurrentWorkerMessage(
  handlerLoadToken: number,
  currentLoadToken: number,
  currentSessionVersion: number,
  messageSessionVersion: unknown,
): boolean {
  if (handlerLoadToken !== currentLoadToken) {
    return false;
  }

  const sessionVersion = Number(messageSessionVersion);
  return !Number.isFinite(sessionVersion)
    || sessionVersion < 0
    || sessionVersion === currentSessionVersion;
}
