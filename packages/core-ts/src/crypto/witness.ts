import type { WitnessTemplate } from "../contract/types.js";
import { CryptoError } from "./errors.js";

export interface WitnessValues {
  /** DER + sighash-byte signatures, by signer. */
  signatures: Partial<Record<"owner" | "cosigner" | "guardian", string>>;
  /** The witness script (the Vault Script or Allowance script). */
  scriptHex: string;
}

/**
 * Fills a contract-published witness template in its exact slot order (bottom of the stack
 * first). Clients never reorder slots; a missing signature is an error, not an empty item.
 */
export function fillWitness(template: WitnessTemplate, values: WitnessValues): string[] {
  return template.slots.map((slot) => {
    switch (slot.kind) {
      case "signature": {
        const signature = values.signatures[slot.signer];
        if (!signature)
          throw new CryptoError(`Missing ${slot.signer} signature for the ${template.path} path`);
        return signature;
      }
      case "selector":
        return slot.hex;
      case "empty":
        return "";
      case "script":
        return values.scriptHex;
    }
  });
}
