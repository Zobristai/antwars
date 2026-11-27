import { fillFfaRecords } from "../src/rating/ffaRecordFill.js";
import { firestoreFromEnv } from "../src/store/firestore.js";

const args = process.argv.slice(2);
if (args.length && !(args.length === 1 && args[0] === "--apply")) throw new Error("Usage: fill-ffa-records.ts [--apply]");
const store = firestoreFromEnv(process.env);
if (!store) throw new Error("Set the intended store namespace and project explicitly");
console.log(JSON.stringify({ namespace: store.namespace, apply: args.length > 0, ...await fillFfaRecords(store, args.length > 0) }, null, 2));
