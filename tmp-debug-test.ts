import { createCliLogger } from "./src/foundation/logger/create-cli-logger.ts";

const logger = createCliLogger({ task: "ask", label: "[gpt-5-cli]", debug: false });
logger.level = "debug";
for (const transport of logger.transports) {
  console.log("transport level:", transport.level);
}
logger.debug("debug message visible?");
