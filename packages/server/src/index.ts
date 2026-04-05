import * as restate from "@restatedev/restate-sdk";
import { workspace } from "./workspace/workspace.js";

const PORT = parseInt(process.env.PORT ?? "9080", 10);

restate
  .endpoint()
  .bind(workspace)
  .listen(PORT);

console.log(`[workspace-service] listening on :${PORT}`);
