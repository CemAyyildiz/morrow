// The connected NEAR wallet of a wallet page: restored silently when near-connect remembers a
// previous connection, otherwise connected through the picker on request.
import { useCallback, useEffect, useState } from "react";
import { USER_CANCEL, connectWallet, disconnectWallet, readCspNonce, restoreWallet } from "./near";
import type { WalletStatus } from "./ui";

export interface WalletControl {
  /** Null when the page was served without its nonce: no wallet can load. */
  nonce: string | null;
  status: WalletStatus;
  connect: () => void;
  disconnect: () => void;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "unknown error";
}

export function useWallet(): WalletControl {
  const [nonce] = useState(() => readCspNonce());
  const [status, setStatus] = useState<WalletStatus>({ kind: "idle" });

  useEffect(() => {
    if (nonce === null) return;
    let live = true;
    void restoreWallet(nonce).then((connected) => {
      if (live && connected !== null) {
        setStatus((current) =>
          current.kind === "idle" ? { kind: "connected", connected } : current,
        );
      }
    });
    return () => {
      live = false;
    };
  }, [nonce]);

  const connect = useCallback(() => {
    if (nonce === null) return;
    setStatus({ kind: "connecting" });
    connectWallet(nonce).then(
      (connected) => setStatus({ kind: "connected", connected }),
      (error: unknown) => {
        const message = messageOf(error);
        // Closing the picker or the wallet (Intear: "Failed to sign in") is no failure: back
        // to Connect.
        if (USER_CANCEL.test(message)) setStatus({ kind: "idle" });
        else setStatus({ kind: "failed", message });
      },
    );
  }, [nonce]);

  const disconnect = useCallback(() => {
    if (nonce === null || status.kind !== "connected") return;
    const { wallet } = status.connected;
    setStatus({ kind: "idle" });
    void disconnectWallet(nonce, wallet);
  }, [nonce, status]);

  return { nonce, status, connect, disconnect };
}
