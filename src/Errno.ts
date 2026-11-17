import type { PlatformError } from "effect/PlatformError"

/** The errno code under a failed file call, such as `EACCES`, which is what chad's messages name. */
export const code = (error: PlatformError): string =>
  (error.reason.cause as NodeJS.ErrnoException | undefined)?.code ?? "unknown"
