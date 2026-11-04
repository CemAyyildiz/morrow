import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { Vault } from "@morrow/core-ts/browser";
import type { AppConfig } from "@/app/data";
import {
  blocksOf,
  recompute,
  recomputeAnnouncement,
  type ProofKit,
  type Recomputed,
  type ScriptRow,
  type ScriptSource,
} from "@/app/proof";
import { useVaultKit } from "@/app/useProof";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { copy } from "@/copy";
import { useReducedMotion } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { useAnnounce } from "@/shell/announce";

const r = copy.proof.recompute;

/** How many bytes ArrowUp / ArrowDown move in the byte view. */
const BYTE_ROW = 16;

// The Address card's recompute (story 6.2): Recompute reads `get_vault_kit` once and runs the
// address and script checks here, in the browser; Flip a byte and the byte view tamper with a
// copy of the script, so the checks turn red, and Reset brings back the published bytes. The
// Allowance Address gets the same recompute in a collapsed second row. Recompute is the page's
// one orange primary; everything else is secondary.
export function AddressRecompute({ vault, config }: { vault: Vault; config: AppConfig }) {
  const { state, read } = useVaultKit(config.nearRpcUrl, config.contractId, vault.vault_id);
  const announce = useAnnounce();
  /** Bumped by every Recompute: the computation has run, and its flips start over. */
  const [run, setRun] = useState(0);
  const [allowanceOpen, setAllowanceOpen] = useState(false);
  const allowanceId = useId();

  const onRecompute = async () => {
    const kit = await read();
    if (kit === null) {
      announce(r.failed);
      return;
    }
    setRun((n) => n + 1);
    const result = recompute(kit, vault);
    if (result) announce(recomputeAnnouncement(result, { kind: "recompute" }));
  };

  const onAllowance = async () => {
    if (allowanceOpen) {
      setAllowanceOpen(false);
      return;
    }
    const kit = await read();
    if (kit === null) {
      announce(r.failed);
      return;
    }
    setAllowanceOpen(true);
    const result = recompute(kit, vault, [], "allowance");
    if (result) announce(recomputeAnnouncement(result, { kind: "recompute" }));
  };

  const kit = state.kind === "ok" ? state.kit : null;
  return (
    <div data-testid="recompute" className="mt-4 flex flex-col gap-4 border-t border-line pt-4">
      <p className="text-[13px] leading-[1.55] text-muted">{r.intro}</p>
      <div>
        <Button
          variant="primary"
          data-testid="recompute-action"
          onClick={() => void onRecompute()}
          disabled={state.kind === "loading"}
        >
          {state.kind === "loading" ? r.reading : r.action}
        </Button>
      </div>
      {state.kind === "failed" && (
        <div data-testid="recompute-failed" className="flex flex-col items-start gap-2">
          <p className="text-[14px] font-semibold text-alarm">{r.failed}</p>
          <p className="text-[13px] text-muted">{r.failedBody}</p>
          <Button variant="secondary" onClick={() => void onRecompute()}>
            {r.retry}
          </Button>
        </div>
      )}
      {kit && run > 0 && <ScriptView key={run} kit={kit} vault={vault} source="vault" />}
      <div className="border-t border-line pt-4">
        <Button
          variant="secondary"
          data-testid="recompute-allowance-toggle"
          aria-expanded={allowanceOpen}
          aria-controls={allowanceId}
          onClick={() => void onAllowance()}
          disabled={state.kind === "loading"}
        >
          {r.allowanceToggle}
        </Button>
        <div id={allowanceId} hidden={!allowanceOpen} className="mt-4">
          {kit && allowanceOpen && <ScriptView kit={kit} vault={vault} source="allowance" />}
        </div>
      </div>
    </div>
  );
}

/** One script, recomputed: both checks, Flip a byte and Reset, the decoded rows and the bytes. */
export function ScriptView({
  kit,
  vault,
  source,
}: {
  kit: ProofKit;
  vault: Vault;
  source: ScriptSource;
}) {
  const announce = useAnnounce();
  const reduced = useReducedMotion();
  const [flipped, setFlipped] = useState<number[]>([]);
  const [focus, setFocus] = useState(0);
  const bytes = useRef<(HTMLButtonElement | null)[]>([]);
  const flipButton = useRef<HTMLButtonElement>(null);
  const resetButton = useRef<HTMLButtonElement>(null);
  const result = useMemo(
    () => recompute(kit, vault, flipped, source),
    [kit, vault, flipped, source],
  );
  if (result === null) return null;

  const change = (next: number[], at: number | null) => {
    setFlipped(next);
    const after = recompute(kit, vault, next, source);
    if (!after) return;
    announce(
      recomputeAnnouncement(
        after,
        next.length === 0 || at === null ? { kind: "reset" } : { kind: "flip", at },
      ),
    );
  };
  const toggle = (at: number) =>
    change(flipped.includes(at) ? flipped.filter((x) => x !== at) : [...flipped, at], at);
  const target = result.flipTarget;

  const onByteKey = (event: KeyboardEvent<HTMLButtonElement>, at: number) => {
    const last = result.bytes.length - 1;
    const moves: Record<string, number> = {
      ArrowRight: at + 1,
      ArrowLeft: at - 1,
      ArrowDown: at + BYTE_ROW,
      ArrowUp: at - BYTE_ROW,
      Home: 0,
      End: last,
    };
    const to = moves[event.key];
    if (to === undefined) return;
    event.preventDefault();
    const next = Math.min(last, Math.max(0, to));
    setFocus(next);
    bytes.current[next]?.focus();
  };

  const what = source === "vault" ? r.vaultAddress : r.allowanceAddress;
  const motion = reduced ? "" : "transition-colors duration-300";
  return (
    <div
      data-testid={`recompute-${source}`}
      data-flipped={flipped.length > 0}
      className="flex min-w-0 flex-col gap-4"
    >
      <Checks result={result} vault={vault} what={what} motion={motion} />
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap gap-2">
          <Button
            ref={flipButton}
            variant="secondary"
            data-testid="recompute-flip"
            disabled={flipped.includes(target)}
            onClick={() => {
              toggle(target);
              // The pressed button is now disabled: Reset is next.
              queueMicrotask(() => resetButton.current?.focus());
            }}
          >
            {r.flip}
          </Button>
          <Button
            ref={resetButton}
            variant="secondary"
            data-testid="recompute-reset"
            disabled={flipped.length === 0}
            onClick={() => {
              change([], null);
              queueMicrotask(() => flipButton.current?.focus());
            }}
          >
            {r.reset}
          </Button>
        </div>
        <p className="text-[13px] text-muted">
          {r.flipHint(target)}
          {flipped.length > 0 && <> {r.flippedNote(flipped.length)}</>}
        </p>
      </div>
      <Decoded result={result} vault={vault} motion={motion} />
      <div className="flex min-w-0 flex-col gap-2">
        <h3 className="text-label text-muted">{r.bytes}</h3>
        <div
          role="group"
          aria-label={r.bytesLabel}
          data-testid="script-bytes"
          className="flex flex-wrap font-mono text-[12px]"
        >
          {Array.from(result.bytes, (byte, at) => {
            const hex = byte.toString(16).padStart(2, "0");
            const isFlipped = result.flipped.includes(at);
            return (
              <button
                key={at}
                ref={(element) => {
                  bytes.current[at] = element;
                }}
                type="button"
                data-testid="script-byte"
                data-offset={at}
                aria-pressed={isFlipped}
                aria-label={r.byteLabel(at, hex, isFlipped)}
                tabIndex={at === focus ? 0 : -1}
                onFocus={() => setFocus(at)}
                onKeyDown={(event) => onByteKey(event, at)}
                onClick={() => toggle(at)}
                className={cn(
                  "h-11 w-7 cursor-pointer rounded-[6px] border border-transparent text-ink hover:border-line",
                  motion,
                  isFlipped && "border-alarm bg-alarm/15 text-alarm",
                )}
              >
                {hex}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** The address check and the script check, each with its colour and its words. */
function Checks({
  result,
  vault,
  what,
  motion,
}: {
  result: Recomputed;
  vault: Vault;
  what: string;
  motion: string;
}) {
  const check = result.scriptCheck;
  const where = !check.ok && check.at !== null ? ` ${r.atByte(check.at)}` : "";
  return (
    <div className="flex flex-col gap-3">
      <div
        data-testid="address-check"
        data-match={result.addressMatch}
        className={cn(
          "flex flex-col gap-1.5 rounded-[12px] border p-3",
          motion,
          result.addressMatch ? "border-ok/40" : "border-alarm/60",
        )}
      >
        <div className="flex items-center gap-2">
          <h3 className="text-label text-muted">{r.addressCheck}</h3>
          <Badge variant={result.addressMatch ? "ok" : "alarm"}>
            {result.addressMatch ? r.match : r.noMatch}
          </Badge>
        </div>
        <p
          data-testid="address-check-text"
          className={cn(
            "text-[14px] [overflow-wrap:anywhere]",
            result.addressMatch ? "text-ok" : "text-alarm",
          )}
        >
          <span className="font-mono text-mono">{result.address}</span>{" "}
          {result.addressMatch ? r.matches(what) : r.noMatchText(what)}{" "}
          <span className="font-mono text-mono">{result.funded}</span>
        </p>
        <dl className="grid grid-cols-1 gap-x-3 gap-y-0.5 text-[12px] text-muted desktop:grid-cols-[auto_minmax(0,1fr)]">
          <dt>{r.recomputed}</dt>
          <dd data-testid="address-recomputed" className="font-mono [overflow-wrap:anywhere]">
            {result.address}
          </dd>
          <dt>{r.funded(what)}</dt>
          <dd data-testid="address-funded" className="font-mono [overflow-wrap:anywhere]">
            {result.funded}
          </dd>
        </dl>
      </div>
      <div
        data-testid="script-check"
        data-match={check.ok}
        className={cn(
          "flex flex-col gap-1.5 rounded-[12px] border p-3",
          motion,
          check.ok ? "border-ok/40" : "border-alarm/60",
        )}
      >
        <div className="flex items-center gap-2">
          <h3 className="text-label text-muted">{r.scriptCheck}</h3>
          <Badge variant={check.ok ? "ok" : "alarm"}>{check.ok ? r.match : r.noMatch}</Badge>
        </div>
        <p
          data-testid="script-check-text"
          className={cn(
            "text-[14px] [overflow-wrap:anywhere]",
            check.ok ? "text-ok" : "text-alarm",
          )}
        >
          {check.ok
            ? r.scriptOk(
                vault.policy.guardians.length,
                blocksOf(vault.policy.escape_timelock_blocks),
              )
            : r.scriptBad(`${check.element}${where}`)}
        </p>
      </div>
    </div>
  );
}

const PATHS = ["withdrawal", "clawback", "escape"] as const;

/** The decoded script, one monospace row per element, with the three paths it nests. */
function Decoded({ result, vault, motion }: { result: Recomputed; vault: Vault; motion: string }) {
  // The legend reads the numbers the script itself encodes, where they line up.
  const numberOf = (kind: ScriptRow["kind"]) =>
    result.rows.find((row) => row.kind === kind)?.number ?? null;
  const guardians = numberOf("guardian_count") ?? vault.policy.guardians.length;
  const timelock = numberOf("timelock") ?? vault.policy.escape_timelock_blocks;
  const rules = r.pathRules(guardians, blocksOf(timelock));
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <h3 className="text-label text-muted">{r.decoded(result.bytes.length)}</h3>
      <dl data-testid="script-paths" className="flex flex-col gap-1 text-[13px]">
        {PATHS.map((path) => (
          <div key={path} data-path={path} className="flex flex-wrap gap-x-2">
            <dt className="font-semibold">{r.pathNames[path]}</dt>
            <dd className="text-muted">{rules[path]}</dd>
          </div>
        ))}
      </dl>
      <ol data-testid="script-rows" className="divide-y divide-line font-mono text-mono">
        {result.rows.map((row) => (
          <Row key={row.index} row={row} motion={motion} />
        ))}
      </ol>
    </div>
  );
}

function Row({ row, motion }: { row: ScriptRow; motion: string }) {
  const path = row.path === null ? null : r.pathNames[row.path];
  const where = row.branch === null ? path : path === null ? row.branch : `${row.branch} · ${path}`;
  return (
    <li
      data-testid="script-row"
      data-offset={row.offset}
      data-path={row.path ?? ""}
      data-differs={row.differs}
      data-flipped={row.flipped}
      className={cn(
        "grid grid-cols-[2.25rem_minmax(0,1fr)] gap-x-3 px-1 py-1.5",
        motion,
        row.flipped ? "bg-alarm/15" : row.differs && "bg-alarm/8",
      )}
    >
      <span className="text-muted">{r.offset(row.offset)}</span>
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className={cn(row.branch !== null && "font-semibold")}>{row.name}</span>
          {row.number !== null && (
            <span className="text-muted">= {row.number.toLocaleString("en-US")}</span>
          )}
        </div>
        {row.data !== null && (
          <div
            data-testid="script-row-data"
            className={cn("[overflow-wrap:anywhere]", row.differs && "text-alarm")}
          >
            {row.data}
          </div>
        )}
        <div className="font-sans text-[12px] text-muted">
          {[row.role, where].filter((part) => part !== null).join(" · ")}
          {row.differs && (
            <span data-testid="script-row-differs" className="text-alarm">
              {" · "}
              {r.rowDiffers}
            </span>
          )}
        </div>
      </div>
    </li>
  );
}
