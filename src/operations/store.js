import fs from "node:fs/promises";
import path from "node:path";

const EMPTY_STATE = Object.freeze({
  version: 1,
  sequence: 0,
  conversations: {},
  messages: {},
  handoffs: {},
  contacts: {},
  notifications: {},
  contentRevisions: {},
  systemConfig: {},
  authSessions: {}
});

function clone(value) {
  return structuredClone(value);
}

export class FileOperationsStore {
  constructor({ directory }) {
    this.directory = path.resolve(directory);
    this.snapshotPath = path.join(this.directory, "operations.json");
    this.ledgerPath = path.join(this.directory, "events.ndjson");
    this.state = clone(EMPTY_STATE);
    this.queue = Promise.resolve();
  }

  async init() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const parsed = JSON.parse(await fs.readFile(this.snapshotPath, "utf8"));
      this.state = { ...clone(EMPTY_STATE), ...parsed };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await this.#writeSnapshot(this.state);
    }
    await fs.open(this.ledgerPath, "a", 0o600).then((handle) => handle.close());
    return this;
  }

  async read(reader = (state) => state) {
    await this.queue;
    return clone(reader(this.state));
  }

  async transact(mutator, event) {
    const operation = this.queue.then(async () => {
      const next = clone(this.state);
      const result = await mutator(next);
      next.version = Number(this.state.version || 0) + 1;
      await this.#writeSnapshot(next);
      this.state = next;
      if (event) await this.#appendLine({ ...event, at: event.at || new Date().toISOString(), snapshotVersion: next.version });
      return clone(result);
    });
    this.queue = operation.catch(() => {});
    return operation;
  }

  async appendEvent(event) {
    const operation = this.queue.then(() => this.#appendLine({ ...event, at: event.at || new Date().toISOString() }));
    this.queue = operation.catch(() => {});
    return operation;
  }

  async listEvents({ after, limit = 100, kind } = {}) {
    await this.queue;
    let text;
    try {
      text = await fs.readFile(this.ledgerPath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    const events = text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    return events
      .filter((item) => (!after || item.at > after) && (!kind || item.kind === kind))
      .slice(-Math.max(1, Math.min(Number(limit) || 100, 500)));
  }

  async close() {
    await this.queue;
  }

  async #writeSnapshot(value) {
    const temporary = `${this.snapshotPath}.${process.pid}.${Date.now()}.tmp`;
    const handle = await fs.open(temporary, "w", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, this.snapshotPath);
    try {
      const directory = await fs.open(this.directory, "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } catch (error) {
      if (!(["EINVAL", "ENOTSUP", "EISDIR"].includes(error.code))) throw error;
    }
  }

  async #appendLine(event) {
    const handle = await fs.open(this.ledgerPath, "a", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    return clone(event);
  }
}

export async function createOperationsStore(config, rootDir) {
  const directory = path.isAbsolute(config.OPERATIONS_DATA_DIR)
    ? config.OPERATIONS_DATA_DIR
    : path.join(rootDir, config.OPERATIONS_DATA_DIR);
  return new FileOperationsStore({ directory }).init();
}
