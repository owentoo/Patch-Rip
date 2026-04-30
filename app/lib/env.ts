export function isDevMode(): boolean {
  return process.env.DEV_MODE === "true";
}

export function devModeSuppress(action: string): boolean {
  if (isDevMode()) {
    console.log(`[DEV_MODE] suppressing: ${action}`);
    return true;
  }
  return false;
}
