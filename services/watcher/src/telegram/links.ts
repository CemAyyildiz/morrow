import { randomInt } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type LinkRole = "owner" | "guardian";

export interface Link {
  chat_id: number;
  vault_id: string;
  account_id: string;
  role: LinkRole;
  linked_at: string;
}

interface PendingCode {
  vault_id: string;
  account_id: string;
  role: LinkRole;
  expires_at: number;
}

interface State {
  links: Link[];
  codes: Record<string, PendingCode>;
}

export const CODE_TTL_MS = 10 * 60 * 1000;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const withoutCodes = (
  codes: Record<string, PendingCode>,
  drop: (code: string, pending: PendingCode) => boolean,
): Record<string, PendingCode> =>
  Object.fromEntries(Object.entries(codes).filter(([code, pending]) => !drop(code, pending)));

/** Telegram chat links, kept only in the watcher's own store (never on-chain). */
export abstract class LinkStore {
  protected abstract load(): Promise<State>;
  protected abstract save(state: State): Promise<void>;

  /** A single-use 8-character code that links the chat that sends it to this Vault role. */
  async createCode(
    vaultId: string,
    accountId: string,
    role: LinkRole,
    now = Date.now(),
  ): Promise<string> {
    const state = await this.load();
    const code = Array.from(
      { length: 8 },
      () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)],
    ).join("");
    state.codes = withoutCodes(state.codes, (_, pending) => pending.expires_at < now);
    state.codes[code] = {
      vault_id: vaultId,
      account_id: accountId,
      role,
      expires_at: now + CODE_TTL_MS,
    };
    await this.save(state);
    return code;
  }

  /** Consumes a code; returns the new link, or null if the code is unknown or expired. */
  async redeem(code: string, chatId: number, now = Date.now()): Promise<Link | null> {
    const state = await this.load();
    const key = code.trim().toUpperCase();
    const pending = state.codes[key];
    if (!pending || pending.expires_at < now) return null;
    state.codes = withoutCodes(state.codes, (k) => k === key);
    const link: Link = {
      chat_id: chatId,
      vault_id: pending.vault_id,
      account_id: pending.account_id,
      role: pending.role,
      linked_at: new Date(now).toISOString(),
    };
    state.links = state.links.filter(
      (l) => !(l.chat_id === chatId && l.vault_id === link.vault_id && l.role === link.role),
    );
    state.links.push(link);
    await this.save(state);
    return link;
  }

  async linksForVault(vaultId: string): Promise<Link[]> {
    return (await this.load()).links.filter((l) => l.vault_id === vaultId);
  }
}

const empty = (): State => ({ links: [], codes: {} });

export class InMemoryLinkStore extends LinkStore {
  private state = empty();

  protected async load(): Promise<State> {
    return structuredClone(this.state);
  }

  protected async save(state: State): Promise<void> {
    this.state = structuredClone(state);
  }
}

export class FileLinkStore extends LinkStore {
  constructor(private readonly path: string) {
    super();
  }

  protected async load(): Promise<State> {
    try {
      return { ...empty(), ...(JSON.parse(await readFile(this.path, "utf8")) as Partial<State>) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty();
      throw error;
    }
  }

  protected async save(state: State): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
    await rename(temporary, this.path);
  }
}
