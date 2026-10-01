import path from 'path';
import { fileURLToPath } from 'url';

// Monorepo root resolved via import.meta.url (not process.cwd()).
// This file lives at packages/server/src/config/paths.ts
// Compiled to packages/server/dist/config/paths.js
// 4 levels up: config → dist → server → packages → root
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(__dirname, '..', '..', '..', '..');
