// Preview the game's production build using its normal Vite configuration.
// Build first. Avoids development dependency scanning in restricted sandboxes.
import { preview } from 'vite';
import config from '../../../game/vite.config.mjs';
const server = await preview({ ...config, configFile: false });
server.printUrls();
