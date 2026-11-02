import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface WatcherProgress {
  /** Last fully handled event seq ("0" before the first event). */
  cursor: string;
  last_block_timestamp: string | null;
  updated_at: string | null;
}

/**
 * Watcher persistence port. Marks record that one handler finished one event, so a restart
 * never re-runs it; the cursor is committed once every handler for that event is marked.
 */
export interface WatcherStore {
  progress(): Promise<WatcherProgress>;
  isHandled(seq: string, handler: string): Promise<boolean>;
  markHandled(seq: string, handler: string): Promise<void>;
  /** Advances the cursor and drops marks at or below it. */
  commit(seq: string, blockTimestamp: string): Promise<void>;
}

interface State extends WatcherProgress {
  handled: Record<string, string[]>;
}

const initial = (): State => ({
  cursor: "0",
  last_block_timestamp: null,
  updated_at: null,
  handled: {},
});

abstract class StateStore implements WatcherStore {
  protected abstract load(): Promise<State>;
  protected abstract save(state: State): Promise<void>;

  async progress(): Promise<WatcherProgress> {
    const { cursor, last_block_timestamp, updated_at } = await this.load();
    return { cursor, last_block_timestamp, updated_at };
  }

  async isHandled(seq: string, handler: string): Promise<boolean> {
    return (await this.load()).handled[seq]?.includes(handler) ?? false;
  }

  async markHandled(seq: string, handler: string): Promise<void> {
    const state = await this.load();
    const marks = state.handled[seq] ?? [];
    if (!marks.includes(handler)) state.handled[seq] = [...marks, handler];
    await this.save(state);
  }

  async commit(seq: string, blockTimestamp: string): Promise<void> {
    const state = await this.load();
    state.cursor = seq;
    state.last_block_timestamp = blockTimestamp;
    state.updated_at = new Date().toISOString();
    state.handled = Object.fromEntries(
      Object.entries(state.handled).filter(([key]) => BigInt(key) > BigInt(seq)),
    );
    await this.save(state);
  }
}

export class InMemoryStore extends StateStore {
  private state = initial();

  protected async load(): Promise<State> {
    return structuredClone(this.state);
  }

  protected async save(state: State): Promise<void> {
    this.state = structuredClone(state);
  }
}

/** Local development store: one JSON file, replaced atomically on every write. */
export class FileStore extends StateStore {
  constructor(private readonly path: string) {
    super();
  }

  protected async load(): Promise<State> {
    try {
      return { ...initial(), ...(JSON.parse(await readFile(this.path, "utf8")) as Partial<State>) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return initial();
      throw error;
    }
  }

  protected async save(state: State): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(state));
    await rename(temporary, this.path);
  }
}
