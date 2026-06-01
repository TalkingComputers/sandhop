export class KeeponError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeeponError";
  }
}

export class NotSupportedError extends KeeponError {
  constructor(message: string) {
    super(message);
    this.name = "NotSupportedError";
  }
}
