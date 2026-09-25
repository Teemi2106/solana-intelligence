/** Narrows a value that must exist by construction; throws (a bug, not a data condition) when it does not. */
export function defined<T>(value: T | null | undefined, message = "INVARIANT_VIOLATED"): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}
