import { describe, expect, it, vi } from 'vitest';
import { requestGramProcessRestart } from '../gramFatalRecovery.js';

describe('requestGramProcessRestart', () => {
  it('logs the timeout reason and exits so Docker can recreate the process', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exit = vi.fn((code: number): never => {
      throw new Error(`exit:${code}`);
    });

    expect(() => requestGramProcessRestart('StatsRefresher GetMessages timed out', exit))
      .toThrow('exit:1');
    expect(errorSpy).toHaveBeenCalledWith(
      '[GramRecovery] fatal MTProto timeout: StatsRefresher GetMessages timed out; exiting for Docker restart'
    );
    expect(exit).toHaveBeenCalledWith(1);

    errorSpy.mockRestore();
  });
});
