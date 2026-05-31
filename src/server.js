import { createApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const app = await createApp(config);

app.listen(config.port, () => {
  console.log(`atlas-unified-search listening on http://localhost:${config.port}`);
});
