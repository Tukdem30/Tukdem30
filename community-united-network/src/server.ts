import { createApp } from "./app.js";
import { config } from "./config.js";
import { migrate } from "./db.js";

await migrate();
const app = createApp();
app.listen(config.port, () => {
  console.log(`Community United Network listening on http://localhost:${config.port}`);
});
