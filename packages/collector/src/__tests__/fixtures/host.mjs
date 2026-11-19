import { getProcessCollector } from "../../../dist/index.js";
const collector = getProcessCollector();
const status = await collector.start();
process.send(status);
process.on("message", async message => {
  if (message === "stop") { await collector.stop(); process.exit(0); }
});
