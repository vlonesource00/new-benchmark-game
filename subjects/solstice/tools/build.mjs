import { build } from 'vite';
import config from '../../../game/vite.config.mjs';
await build({ ...config, configFile: false });
