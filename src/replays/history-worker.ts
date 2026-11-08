import { parentPort, workerData } from "node:worker_threads";
import { matchRecord, unavailableRecord, type HistoryInput } from "./history.js";

const input = workerData as HistoryInput;
try {
  let record;
  try { record = matchRecord(input); }
  catch (error: unknown) { record = unavailableRecord(input.id, error instanceof Error ? error.message : "record decoding failed"); }
  const bytes = new TextEncoder().encode(JSON.stringify(record) + "\n");
  parentPort!.postMessage({ bytes }, [bytes.buffer]);
} catch (error: unknown) {
  parentPort!.postMessage({ error: error instanceof Error ? error.message : "match record could not be produced" });
}
