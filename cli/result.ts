export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

export const success = <T>(value: T): Result<T> => ({ ok: true, value });

export const failure = (error: string): Result<never> => ({ ok: false, error });

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function attempt<T>(operation: () => T): Result<T> {
  try {
    return success(operation());
  } catch (error: unknown) {
    return failure(errorMessage(error));
  }
}
