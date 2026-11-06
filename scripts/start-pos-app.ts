/**
 * RUBE-STOCK-POS v3.1 Live Interactive Desktop/Web Launcher (`npm start`)
 *
 * Boots `RubePosInteractiveAppServer` on `http://127.0.0.1:4173` backed by a persistent
 * SQLite database (`data/rube_pos_live.db`) and USB Ring-Buffer directory (`data/usb-backups/`).
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RubePosInteractiveAppServer } from '../packages/ui-presentation/src/server/pos-desktop-server.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const dbPath = process.env.RUBE_POS_DB_PATH ?? path.join(rootDir, 'data', 'rube_pos_live.db');
const port = Number(process.env.PORT ?? 4173);

const appServer = new RubePosInteractiveAppServer({ dbPath });
const { url } = await appServer.start(port, '127.0.0.1');

console.log('===================================================================');
console.log('🚀 RUBE-STOCK-POS v3.1 Interactive Full-Stack Application Running!');
console.log(`🌐 Open in Browser / WebView2: ${url}`);
console.log(`🗄️  SQLite WAL Database:        ${dbPath}`);
console.log('===================================================================');

