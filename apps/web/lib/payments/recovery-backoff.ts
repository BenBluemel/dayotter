export function retryAt(failures: number) {
  return new Date(Date.now() + Math.min(3600, 15 * 2 ** Math.min(failures, 8)) * 1000);
}
