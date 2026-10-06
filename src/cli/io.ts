/**
 * CLI input/output. Ordinary stdout output is allowed only here;
 * other gateway components log to stderr.
 */
import { createInterface } from 'node:readline';

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
  /** Ask a human for text; hidden suppresses password/code echo. */
  prompt(question: string, options?: { hidden?: boolean }): Promise<string>;
}

export const terminalIo: CliIo = {
  out: line => void process.stdout.write(line + '\n'),
  err: line => void process.stderr.write(line + '\n'),
  prompt: (question, options = {}) =>
    new Promise<string>((resolve, reject) => {
      if (!process.stdin.isTTY) {
        reject(new Error('This command needs an interactive terminal.'));
        return;
      }
      // Prompts go to stderr, leaving stdout clean for command results.
      const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
      if (options.hidden) {
        const masked = rl as unknown as { _writeToOutput: (text: string) => void };
        masked._writeToOutput = (text: string) => {
          // Display only the prompt. Backspace makes readline redraw the entire
          // prompt and input; typed secret characters must never be displayed.
          if (text.includes(question)) process.stderr.write(question);
        };
      }
      rl.question(question, answer => {
        rl.close();
        if (options.hidden) process.stderr.write('\n');
        resolve(answer.trim());
      });
      rl.on('SIGINT', () => {
        rl.close();
        reject(new Error('Cancelled.'));
      });
    }),
};
