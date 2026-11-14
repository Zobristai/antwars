/** Vite module-worker entry for the replay scrubber's marks (recording.ts serveMarks). No DOM work occurs here. */
import { serveMarks, type MarksPort } from "./recording.ts";

// tsconfig includes DOM rather than WebWorker; spell only the worker port we use, not a Window cast.
serveMarks(globalThis as unknown as MarksPort);
