export type ExitProcess = (code: number) => never;

/**
 * A timed-out GramJS request cannot be cancelled safely. Reusing or replacing
 * the shared STRING_SESSION in-process risks overlapping clients and
 * AUTH_KEY_DUPLICATED. Production runs under Docker restart: unless-stopped,
 * so fail closed and let Docker recreate the single client from clean state.
 */
export function requestGramProcessRestart(
  reason: string,
  exitProcess: ExitProcess = code => process.exit(code)
): never {
  console.error(
    `[GramRecovery] fatal MTProto timeout: ${reason}; exiting for Docker restart`
  );
  return exitProcess(1);
}
