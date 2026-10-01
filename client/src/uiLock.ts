/**
 * Pointer-lock helper (REFACTORING.md Phase 3): the requestPointerLock call
 * with the Chrome ≥111 Promise-rejection swallow, repeated verbatim in
 * player.ts's requestLock and main.ts's shop/chat re-lock paths. The unlock
 * side is a bare document.exitPointerLock() everywhere and stays unwrapped.
 */

/**
 * Requests the pointer lock on `canvas`, swallowing the rejection Chrome ≥111
 * produces when the lock is denied (e.g. re-locking too soon after Esc) —
 * the overlay stays up and the next click retries.
 */
export function lockPointer(canvas: HTMLElement): void {
  const result = canvas.requestPointerLock() as unknown as Promise<void> | undefined;
  if (result instanceof Promise) result.catch(() => undefined);
}
