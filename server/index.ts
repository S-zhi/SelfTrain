import { apiPort } from './config';
import { openDatabase } from './db';
import { buildServer } from './routes';

const db = openDatabase();
const app = await buildServer(db);
const port = apiPort();

try {
  await app.listen({ port, host: '127.0.0.1' });
  console.info(`SelfTrain 已启动：http://127.0.0.1:${port}`);
} catch (error) {
  console.error('SelfTrain 启动失败：', error);
  db.close();
  process.exitCode = 1;
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    await app.close();
    db.close();
    process.exit();
  });
}
