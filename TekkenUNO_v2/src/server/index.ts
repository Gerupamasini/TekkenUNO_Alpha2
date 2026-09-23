// サーバーの起動（Render では npm start でこれが動く）
import { BUILD, VERSION, startServer } from "./app.js";

const app = startServer({ port: Number(process.env.PORT ?? 10000), clientDir: process.env.CLIENT_DIR });

app.ready.then((port) => {
  console.log(`鉄研UNO server v${VERSION} (build ${BUILD}) listening on :${port}`);
});

function shutdown() {
  app.close().then(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
