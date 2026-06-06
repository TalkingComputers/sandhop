export interface TransferProgress {
  label: string;
  phase: "compress" | "upload" | "extract";
  bytesDone: number;
  bytesTotal: number;
}

export type PushEvent =
  | { kind: "enrichStep"; name: string; status: "start" | "ok" | "fail" }
  | { kind: "transfer"; transfer: TransferProgress }
  | { kind: "done"; okSteps: number; totalSteps: number };

export type PushListener = (e: PushEvent) => void;
