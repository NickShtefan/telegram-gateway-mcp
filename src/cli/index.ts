#!/usr/bin/env node
/**
 * Точка входа `tg-mcp`. Первым делом console.log уводится в stderr, и только
 * потом загружается остальной код вместе с teleproto: в stdio-режиме любая чужая
 * строка в stdout ломает JSON-RPC.
 */
import { redirectConsoleToStderr } from '../core/log.js';

redirectConsoleToStderr();
// База, ключ и сокет шлюза доступны только его пользователю. Файлы для агентов
// (выгрузки, картинки) получают права явно при записи.
process.umask(0o077);

const { main } = await import('./main.js');
const code = await main(process.argv.slice(2));
process.exitCode = code;
// У демона остаётся таймер уборки: после остановки выходим сразу.
if (process.argv[2] === 'serve') process.exit(code);
