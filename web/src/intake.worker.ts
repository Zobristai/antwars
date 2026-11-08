/** Vite module-worker entry. No animation clock or DOM work occurs here. */
import { IntakeProcessor, intakeTransfers, type IntakeRequest, type IntakeReply } from "./intake.ts";

const processor = new IntakeProcessor();
// tsconfig includes DOM rather than WebWorker; spell only the worker port we use, not a Window cast.
const port = globalThis as unknown as {
  onmessage: (event: MessageEvent<IntakeRequest>) => void;
  postMessage(reply: IntakeReply, transfers: ArrayBuffer[]): void;
};
port.onmessage = ({ data }) => {
  void processor.handle(data).then((reply) => {
    if (reply) port.postMessage(reply, intakeTransfers(reply));
  });
};
