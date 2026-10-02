// TEST 5 — registra el hook de reescritura de blackLitterman (ver bl_loader.mjs)
import { register } from 'node:module';
register('./bl_loader.mjs', import.meta.url);
