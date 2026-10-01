/**
 * Ввод и вывод команд CLI. Обычный вывод идёт в stdout только здесь: всё
 * остальное в шлюзе пишет в stderr.
 */
import { createInterface } from 'node:readline';

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
  /** Спрашивает строку у человека. hidden прячет ввод (пароль, код). */
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
      // Вопросы идут в stderr, чтобы stdout оставался чистым для результата.
      const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
      if (options.hidden) {
        const masked = rl as unknown as { _writeToOutput: (text: string) => void };
        masked._writeToOutput = (text: string) => {
          // Сам вопрос показываем, набранные символы нет.
          if (text.includes(question)) process.stderr.write(text);
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
