// Shell copy. Rules (checked by copy.test.ts): no emoji, no exclamation marks, no hype
// words, no relative times. Times arrive as absolute values from data.
import type { BtcNetwork, NearNetwork, NetworkPair } from "@/app/data";

const BTC_COINS: Record<Exclude<BtcNetwork, "bitcoin">, string> = {
  testnet: "Testnet",
  signet: "Signet",
  regtest: "Regtest",
};

const NEAR_SIDE: Record<NearNetwork, string> = {
  mainnet: "NEAR mainnet",
  testnet: "NEAR testnet",
  mock: "mock contract",
};

/** `1 attempt`, `2 attempts`. */
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

export const copy = {
  wordmark: "morrow",
  skipToContent: "Skip to content",

  nav: {
    label: "Main",
    vault: "Vault",
    challenge: "Challenge",
    proof: "Proof",
    xray: "X-Ray",
    lost: "Lost a device?",
    live: "live",
    openMenu: "Open menu",
    closeMenu: "Close menu",
    menu: "Menu",
    backHome: "Back to home",
    backTo: (page: string) => `Back to ${page}`,
  },

  titles: {
    vault: "Vault",
    challenge: "Challenge vault",
    proof: "Proof",
    xray: "X-Ray",
    lost: "Lost a device?",
    notFound: "Not found",
  },

  system: {
    contract: "contract",
    coSigner: "co-signer",
    contractState: {
      locked: "locked",
      unlocked: "unlocked",
      checking: "checking",
      unknown: "unknown",
    },
    /**
     * The heartbeat's age, wording fixed by story 1.9b. A duration since the watcher's last
     * report, not a time of day, so copy.test.ts exempts it from the relative-time rule.
     */
    alertsSeen: (minutes: number) => `Alerts: watcher last seen ${minutes} min ago`,
    alertsNone: "Alerts: no watcher configured",
    alertsChecking: "Alerts: checking watcher",
    alertsUnreachable: "Alerts: watcher unreachable",
    alertsSilent: "Alerts: watcher has not reported",
  },

  config: {
    loading: "Loading the deployment configuration",
    failedTitle: "Configuration unavailable",
    failedBody:
      "This deployment did not serve a valid /config.json, so the app cannot tell which networks or contract it belongs to.",
  },

  challenge: {
    noRound: "No round is open yet",
    noRoundBody:
      "When a round opens, its vault, the published owner keys and every attempt to use them appear here.",
    unreachable: "The Challenge feed is not answering",
    unreachableBody: "The page asks again every 30 seconds. Retrying.",
    round: (round: number) => `round ${round}`,
    keysPublished: "keys published",
    downloadKeys: "Download keys",
    tryKeys: "Try with these keys",
    nextWithdrawal: "Next possible withdrawal",
    requested: (at: string) => `Requested ${at}`,
    /** The earliest withdrawal time with its date, when it is not today. */
    timeOnDay: (time: string, day: string) => `${time} on ${day}`,
    noRequest: "No withdrawal request is pending",
    left: (remaining: string) => `${remaining} left`,
    /** The right end of the delay bar while no request is pending: the whole Delay. */
    fullDelay: (delay: string) => `${delay} delay`,
    delayElapsed: "Share of the delay that has passed",
    explainer: (time: string) =>
      `Anyone can use this vault's owner keys. The NEAR contract holding the other half won't sign before ${time}, and the guardian sends every attempt home.`,
    attemptsLabel: "Attempts with the published keys",
    /** The words after the attempts numeral: `attempts · 0 sats out`. */
    attemptsUnit: (count: number, satsOut: number) =>
      `${count === 1 ? "attempt" : "attempts"} · ${plural(satsOut, "sat")} out`,
    attemptsWindow: (round: number) => `Round ${round} · last 24 h`,
    lastAttempt: (at: string) => `Last attempt ${at}`,
    noAttemptYet: "No attempt yet",
    hourlySummary: (total: number, activeHours: number, peak: number) =>
      `${plural(total, "attempt")} in ${activeHours} of 24 hours, at most ${peak} in one hour`,
    heldInVault: "Held in vault",
    delay: "Delay",
    perWithdrawal: "per withdrawal",
    satsTaken: "Sats taken",
    coSigner: "Co-signer",
    factsLabel: "About this round",
    /** The coins note for the round's Bitcoin network. */
    coins: (btc: BtcNetwork) =>
      btc === "bitcoin" ? "Real bitcoin" : `${BTC_COINS[btc]} test coins · not real bitcoin`,
    /** The rotation deadline; `at` is an estimate from the tip at 10 minutes per block. */
    rotation: (height: number, at: string | null) =>
      `New vault by block ${height.toLocaleString("en-US")}${at === null ? "" : ` · about ${at}`}`,
    bounty: "Mainnet Bounty",
    /** The `how_to` text of the downloaded keys file. */
    howTo:
      "These are the published keys of a Morrow Challenge Vault. owner_key and owner_key_secret are the Owner Key that signs the Bitcoin side. near_function_call_key signs Vault Contract calls on vault_contract as owner_account. Request a withdrawal from vault_id and try to move the coins at vault_address. The Vault Contract will not co-sign before the Delay ends, and the guardian claws every request back to the operator's Recovery Address. Every attempt appears in the Attempt Log.",
  },

  attemptLog: {
    title: "Attempt log",
    empty: "No attempts this round yet. The keys are above.",
    withdrawal: "Withdrawal Request",
    policyChange: "Policy Change",
    earlyExecute: "Early Execute",
    unknownCall: "Contract call",
    /** Marks a row from an earlier round than the one shown. */
    roundTag: (round: number) => `round ${round}`,
    outcome: {
      clawedBack: (seconds: number) => `Clawed back in ${seconds} s`,
      vetoed: "Vetoed",
      rejected: (code: string) => `Rejected ${code}`,
      pending: "Pending",
      cancelled: "Cancelled",
      signed: "Signed",
      withdrawn: "Withdrawn",
      applied: "Applied",
    },
    nearLink: "NEAR",
    bitcoinLink: "Bitcoin",
    nearTxLabel: (n: number) => `NEAR transaction of attempt ${n}`,
    nearAccountLabel: (n: number) => `Owner Account of attempt ${n} on NEAR`,
    bitcoinTxLabel: (n: number) => `Bitcoin transaction of attempt ${n}`,
    /** Read out once when a new row arrives. */
    announce: (n: number, action: string, outcome: string) => `Attempt ${n}: ${action}, ${outcome}`,
  },

  xray: {
    title: "X-Ray · latest attempt",
    notReached: "not reached",
  },

  /**
   * The X-Ray page (story 6.4): one op, or one refused call, through its four stages. Every
   * value is read from the chain in this browser and names the call it came from.
   */
  xrayPage: {
    loading: "Reading the operation from NEAR",
    opChip: (id: string) => `op #${id}`,
    vaultChip: (id: string) => `vault #${id}`,
    refusedChip: "refused call",
    open: {
      title: "Open an X-Ray",
      body: (contractId: string) =>
        `Follow one operation of ${contractId} through its four stages: Bitcoin script path, Vault Contract rule, NEAR MPC signature, Bitcoin transaction. Everything is read from the chain in this browser.`,
      label: "Op id or refused NEAR transaction hash",
      submit: "Open",
      invalid: "Enter an op id (digits) or a NEAR transaction hash.",
    },
    noNetwork: "X-Ray needs a NEAR network",
    noNetworkBody:
      "X-Ray reads transactions, receipts and the MPC signer from NEAR testnet or mainnet, through an archival NEAR RPC and a transaction indexer. This deployment is not configured with them.",
    input: "Nothing to X-Ray here",
    unreachable: "The chain could not be read",
    unreachableBody:
      "The NEAR RPC, the transaction indexer or the Bitcoin backend did not answer. Nothing is cached, so nothing is shown.",
    stale: (at: string) => `The last read failed. Showing the read from ${at}.`,
    retry: "Retry",
    readAt: (at: string) => `Read at ${at}`,
    reading: (seconds: number) => `Reading the chain again every ${seconds} s.`,
    loadFailed: "The X-Ray page could not be loaded",
    loadFailedBody:
      "The site may have been updated since this page opened. Reload to get the current version.",
    reload: "Reload",
    stages: {
      script: "Bitcoin script path",
      rule: "Vault Contract rule",
      mpc: "NEAR MPC signature",
      bitcoin: "Bitcoin transaction",
    },
    status: {
      done: "done",
      ok: "confirmed",
      pending: "waiting",
      refused: "refused",
      failed: "failed",
      not_reached: "not reached",
    },
    sources: (count: number) => `Sources · ${count}`,
    paths: { withdrawal: "Withdrawal", clawback: "Clawback", escape: "Escape" },
    coinSources: { vault: "Vault Script", allowance: "Allowance Script" },
    script: {
      headline: (path: string, script: string) => `${path} path of the ${script}`,
      failed: "The Vault Kit could not be read",
      decoded: (bytes: number) => `Decoded script · ${bytes} bytes · the op's path highlighted`,
      onPath: "on this path",
      match: "the address recomputed in this browser matches the kit's",
      noMatch: "the address recomputed in this browser does not match the kit's",
      rows: {
        path: "Path",
        coins: "Coins from",
        network: "Bitcoin network",
        address: "Address (get_vault_kit)",
        recomputed: "Address recomputed in this browser",
        scriptHex: "Script",
        template: "Witness template",
      },
      recomputedRef: (scriptRef: string) => `p2wshAddress(${scriptRef}) in this browser`,
      decodedRef: (scriptRef: string) => `decodeScript(${scriptRef}) in this browser`,
    },
    rule: {
      accepted: (state: string) => `Accepted · op ${state}`,
      acceptedAt: (state: string, at: string) => `Accepted · op ${state} · executable_at ${at}`,
      voided: (by: string) => `Voided by Clawback op ${by}`,
      refused: (code: string, gloss: string) => `${code} · ${gloss}`,
      judged: (facts: string, code: string) => `${facts} → ${code}`,
      events: "Events (events_since)",
      event: (kind: string, seq: string) => `${kind} · seq ${seq}`,
      rows: {
        state: "Op state (get_op)",
        executableAt: "executable_at",
        fee: "Fee (op_frozen)",
        voidedBy: "Voided by",
        code: "Error code",
        gloss: "Meaning",
        method: "Method",
        args: "Arguments",
        tx: "NEAR transaction",
        receipt: "Failing receipt",
        blockTime: "Block time",
        stateAtBlock: "Op state when judged",
        executableAtBlock: "executable_at when judged",
      },
    },
    mpc: {
      signed: "Signed by the NEAR MPC network",
      signedBy: (threshold: number, participants: number) =>
        `Signed by the NEAR MPC network (${threshold} of ${participants})`,
      waiting: "Waiting for the NEAR MPC network",
      failed: "The signature does not match what the contract stored",
      input: (index: number) => `Input ${index}`,
      rows: {
        sighash: "Sighash (get_op)",
        payload: "Payload sent to the signer",
        domain: "Domain id",
        path: "Derivation path",
        signer: "Signer account",
        tx: "sign_input transaction",
        signReceipt: "sign receipt",
        responseReceipt: "Signer response receipt",
        callbackReceipt: "on_signed receipt",
        response: "Signer response",
        callbackValue: "on_signed returned",
        signature: "Signature (get_op)",
        participants: "Participants",
        threshold: "Threshold",
        protocol: "Protocol",
      },
    },
    bitcoin: {
      confirmed: (confirmations: number) =>
        `Confirmed · ${confirmations} confirmation${confirmations === 1 ? "" : "s"}`,
      mempool: "In the mempool · 0 confirmations",
      unseen: "Signed, not seen by the Bitcoin backend yet",
      built: "Built by the contract, waiting for its signatures",
      unreadable: "The Bitcoin transaction could not be read",
      rows: {
        txid: "txid",
        confirmations: "Confirmations",
        height: "Block height",
      },
    },
  },

  tryKeys: {
    title: "Try with these keys",
    intro:
      "Sign real NEAR transactions in this browser with the round's published function-call key. The key stays in this page's memory: nothing is stored, and a reload forgets it.",
    destination: "Destination",
    randomTag: "random",
    destinationHelp:
      "A fresh address made in this browser. Nobody holds its key. Edit it to name your own.",
    requestFull: "Request the full balance",
    executeEarly: "Execute early",
    executeTarget: (opId: string) => `Executes request op ${opId}`,
    xrayToggle: "X-Ray",
    reasons: {
      noRpc: "This deployment has no NEAR RPC to send through.",
      badKey: "The published key cannot be read.",
      spent:
        "This key is out of allowance. A fresh key is being published; the buttons come back when it is.",
      noVault: "This round has no vault yet.",
      readingWatcher: "Reading the vault's watcher key.",
      noWatcher: "The vault's watcher key cannot be read, so no envelope can be sealed.",
      readingCoins: "Reading the vault's coins.",
      noCoins: "The vault holds no coins. A new round opens after each Clawback.",
      unconfirmed: "The coins are not confirmed yet.",
      belowFee: "The vault's coins do not cover the fee of a withdrawal.",
      ownPending: "Your request holds the coins until it is clawed back.",
      noPending: "No withdrawal request is pending. Request the full balance first.",
    },
    destinationProblem: {
      malformed: "This is not a valid SegWit address. Nothing was signed.",
      network: "This address belongs to another Bitcoin network. Nothing was signed.",
      version: "The vault pays SegWit v0 and Taproot addresses only. Nothing was signed.",
      program: "This address has a witness program the vault does not accept. Nothing was signed.",
    },
    steps: {
      request: "Request",
      requestIdle: "request_withdrawal or begin_execute",
      signing: "signing",
      notSent: "not sent",
      rule: "Contract rule",
      ruleIdle: "the contract checks the Delay",
      ruleWaiting: "waiting for the transaction result",
      ruleUnknown: "no result to read",
      accepted: "Accepted",
      executeAccepted: "Accepted · the contract took the early execute",
      acceptedAt: (at: string) => `Accepted · executable at ${at}`,
      refused: (code: string, meaning: string | null) =>
        meaning === null ? `Refused · ${code}` : `Refused · ${code} · ${meaning}`,
      mpc: "MPC co-signature",
      mpcIdle: "the NEAR MPC network",
      mpcAfterDelay: "the contract asks the MPC network only after the Delay",
      mpcAsked: "the contract asks the MPC network to co-sign",
      bitcoin: "Bitcoin",
      bitcoinIdle: "the guardian claws every request back",
      waiting: (seconds: number) => `Waiting for the guardian · ${seconds} s`,
      noOpId: "the op id could not be read · the Attempt Log will show the request",
      clawedBack: (seconds: number, txid: string) => `Clawed back in ${seconds} s · ${txid}`,
    },
    notice: {
      seal: "The Watcher Envelope could not be sealed. Nothing was signed.",
      unreachable: "Could not reach NEAR. Nothing was sent.",
      unreadable:
        "The transaction may have been sent, but its result could not be read. The steps stay pending until the Attempt Log shows it.",
      invalidTx: (kind: string) => `NEAR refused the transaction before it ran · ${kind}`,
      nonce: "Other visitors used the key at the same time, twice in a row. Nothing was sent.",
    },
    links: {
      near: "NEAR",
      nearLabel: "NEAR transaction of this attempt",
      bitcoin: "Bitcoin",
      bitcoinLabel: "Bitcoin Clawback transaction of this attempt",
      xray: "Full X-Ray",
      xrayLabel: "Full X-Ray of this attempt, in a new tab",
    },
    announce: (title: string, detail: string) => `${title}: ${detail}`,
  },

  /**
   * The Proof Page (story 6.1). Every value comes from the chain; the guarantee and trust
   * templates take the Vault's own values, so no statement is generic.
   */
  proof: {
    vaultChip: (id: string) => `vault #${id}`,
    liveRound: (round: number) => `challenge round ${round}`,
    xray: "X-Ray",
    xrayLabel: (opId: string) => `X-Ray of op ${opId}`,
    loading: "Reading the Vault from NEAR",
    states: { pending_keys: "pending keys", active: "active", clawed_back: "clawed back" },
    guardianKinds: {
      trusted_contact: "Trusted Contact",
      backup_device: "Backup Device",
      auto_clawback: "Auto-Clawback Guardian",
    },
    sections: {
      policy: "Policy",
      vault: "Vault",
      addresses: "Addresses",
      pending: "Pending",
      contract: "Contract",
      guarantees: "Guarantees",
      trust: "Trust assumptions",
    },
    rows: {
      delay: "Delay",
      policyChangeDelay: "Policy Change Delay",
      escapeTimelock: "Escape Timelock",
      recoveryAddress: "Recovery Address",
      allowanceLimit: "Allowance limit",
      feeCap: "Fee Cap",
      fastApproval: "Fast Approval",
      guardians: "Guardians",
      perDay: (amount: string) => `${amount} per 24 h`,
      fastOn: (floor: string) => `On · Floor ${floor}`,
      fastOff: "Off",
      state: "State",
      owner: "Owner Account",
      created: "Created",
      network: "Bitcoin network",
      vaultAddress: "Vault Address",
      allowanceAddress: "Allowance Address",
      notActive: "Not active yet: its Co-signer keys are still being derived.",
      watcherKey: "Watcher key",
      guardianKey: (key: string) => `key ${key}`,
      codeHash: "code_hash",
      contract: "Contract",
      lock: "Lock",
      watcher: "Watcher",
    },
    pendingWithdrawal: (op: string, amount: string, at: string) =>
      `Withdrawal #${op} · ${amount} · executable ${at}`,
    destination: (address: string) => `to ${address}`,
    frozen: "frozen",
    due: "executable now",
    pendingChange: (id: string, changes: string, at: string) =>
      `Policy Change #${id} · ${changes} · effective ${at}`,
    noPending: "No Withdrawal Request or Policy Change is pending.",
    reading: (count: number) =>
      `Reading the history · ${count.toLocaleString("en-US")} events read`,
    change: {
      field: (label: string, value: string) => `${label} → ${value}`,
      delay: "Delay",
      policyChangeDelay: "Policy Change Delay",
      recoveryAddress: "Recovery Address",
      allowanceLimit: "Allowance limit",
      feeCap: "Fee Cap",
      fastApproval: "Fast Approval",
      fastApprovalFloor: "Fast Approval Floor",
      on: "on",
      off: "off",
      none: "no field",
    },
    locked: "Locked: no full-access keys",
    unlocked: (count: number) => `Unlocked: ${plural(count, "full-access key")}`,
    lockUnknown: "Lock status could not be read",
    unread: "could not be read",
    explorer: "NearBlocks",
    explorerLabel: (contract: string) => `${contract} on NearBlocks (opens in a new tab)`,
    clawedBack: (recovery: string, at: string) => `Sent home to ${recovery} · ${at}`,
    clawedBackUntimed: (recovery: string) => `Sent home to ${recovery}`,
    missing: (id: string, contract: string) => `No Vault #${id} on ${contract}`,
    misconfigured: (contract: string) =>
      `The contract ${contract} did not answer as a Vault Contract`,
    misconfiguredBody:
      "Its account, its code or its get_vault answer is not what a Morrow Vault Contract serves. The page asks again every 30 seconds.",
    missingBody: "The contract has no Vault with this id. Vault ids are the numbers it assigns.",
    unreachable: "Could not reach NEAR",
    unreachableBody:
      "Every value on this page is read from the NEAR RPC, and it did not answer. The page asks again every 30 seconds.",
    stale: {
      unreachable: (at: string) =>
        `Could not reach NEAR · last read ${at}. The values below are from that read; the page asks again every 30 seconds.`,
      missing: (at: string) =>
        `The contract did not answer with this Vault · last read ${at}. The values below are from that read; the page asks again every 30 seconds.`,
      misconfigured: (at: string) =>
        `The contract did not answer as a Vault Contract · last read ${at}. The values below are from that read; the page asks again every 30 seconds.`,
    },
    retry: "Retry",
    noRpc: "No NEAR RPC configured",
    noRpcBody: "This deployment has no NEAR RPC, so the page cannot read any Vault from the chain.",
    open: {
      title: "Open a Vault by id",
      noRound: "No Challenge round is open.",
      feedDown: "The Challenge feed is not answering, so the live round's Vault cannot be shown.",
      noVault: (round: number) => `Challenge round ${round} has no Vault yet.`,
      otherContract: (theirs: string, ours: string) =>
        `The live round's Vault is on ${theirs}, not on ${ours}, so it is not shown here.`,
      body: (contract: string) =>
        `Enter the id of any Vault on ${contract} to read its rules from the chain.`,
      label: "Vault id",
      submit: "Open",
      invalid: "A Vault id is digits only, for example 7.",
    },
    guaranteesIntro: "What the contract and the Vault Script enforce for this Vault.",
    trustIntro: "What these guarantees rely on.",
    repoUrl: "https://github.com/CemAyyildiz/morrow",
    repoLink: "Source: github.com/CemAyyildiz/morrow",
    /** The deployment's watcher heartbeat, an age like the system card's Alerts line. */
    watcher: {
      seen: (minutes: number) => `Deployment watcher last seen ${minutes} min ago`,
      none: "No deployment watcher configured",
      checking: "Checking the deployment watcher",
      unreachable: "Deployment watcher unreachable",
      silent: "Deployment watcher has not reported",
    },
    guarantees: {
      notActive:
        "This Vault is not active yet: its Co-signer keys are still being derived, so it holds nothing and no guarantee applies to it yet.",
      closedTitle: "Sent home",
      closed: (recovery: string, at: string) =>
        `This Vault was sent home to ${recovery} at ${at}; no other spend can be co-signed.`,
      closedUntimed: (recovery: string) =>
        `This Vault was sent home to ${recovery}; no other spend can be co-signed.`,
      g1Due: (op: string) => `Withdrawal #${op} is executable now.`,
      g1Title: "No instant theft",
      g1: (delay: string, blocks: string) =>
        `A withdrawal waits ${delay}. Before a coin's Escape Timelock of ${blocks} matures, no bitcoin leaves the Vault Address sooner than ${delay} after its Withdrawal Request, except back to the Vault Address (Refresh) or to the Recovery Address (Clawback). A thief holding both the Owner Key and the Owner Account still waits ${delay}.`,
      g1Fast: (floor: string) =>
        `Fast Approval is on: a Trusted Contact can shorten the wait to the Fast Approval Floor of ${floor}.`,
      g1Allowance: (amount: string) =>
        `The Spending Allowance pays up to ${amount} per 24 h without the Delay.`,
      g1NoAllowance: "The Spending Allowance is 0, so every spend waits the Delay.",
      g1Earliest: (at: string) => `No pending withdrawal can be signed before ${at}.`,
      g2Title: "Safe-direction recovery",
      g2: (count: number, guardians: string, recovery: string) =>
        `Until a withdrawal executes, any of the ${plural(count, "Guardian")} (${guardians}) can send the whole Vault to the Recovery Address. Clawback pays only ${recovery}.`,
      g3Title: "No hostage",
      g3: (blocks: string, about: string) =>
        `The Co-signer cannot spend alone on any path. If NEAR or the Co-signer stops, the Owner Key alone can spend each coin ${blocks} (about ${about}) after it confirmed, using only Bitcoin.`,
      g4Title: "No silent rule changes",
      g4: (delay: string, recovery: string) =>
        `No Policy field changes sooner than ${delay} after it is proposed, and the Guardians and the Escape Timelock never change for this Vault. Every Guardian is alerted and can veto. A Clawback during a pending change pays the Recovery Address in effect, ${recovery}.`,
      g4Pending: (id: string, at: string) =>
        `Policy Change #${id} cannot take effect before ${at}.`,
    },
    trust: {
      t1Title: "The MPC network signs only what the contract asks",
      t1: (coSigner: string, contract: string) =>
        `The NEAR MPC network behind the configured signer ${coSigner} signs only what ${contract} requests, and stays live. If it stops, G-3 still holds through the Escape Path, and G-1 and G-2 pause until it recovers.`,
      t2Title: "The contract code is correct",
      t2: (contract: string, hash: string) =>
        `The code deployed at ${contract} is correct. It is open source, and its code_hash ${hash} is read from NEAR: build contracts/vault from the public repository and compare.`,
      t2Unread: (contract: string) =>
        `The code deployed at ${contract} is correct. It is open source, but its code_hash could not be read on this refresh to compare with a build of contracts/vault.`,
      t3Title: "The one theft path",
      t3: (count: number, guardians: string, coSigner: string) =>
        `A Guardian and the NEAR MPC network do not collude. If one of the ${plural(count, "Guardian")} (${guardians}) and the network behind the configured signer ${coSigner} do, they can sign a Clawback Path spend to any address, because Bitcoin script cannot restrict destinations. This is the one theft path.`,
      t4Title: "The Recovery Address key stays offline",
      t4: (recovery: string) => `The Owner keeps the private key of ${recovery} safe and offline.`,
      t5Title: "Trusted Contacts are not fooled",
      t5: (contacts: string, floor: string, delay: string) =>
        `Fast Approval is on. A Trusted Contact (${contacts}) does not collude with, or get fooled by, a thief who holds the Owner Key and the Owner Account. If one does, the theft completes after the Fast Approval Floor of ${floor} instead of ${delay}.`,
      t5None: "Fast Approval is on, but this Vault has no Trusted Contact, so it cannot be used.",
      t6Title: "The Guardian Watcher stays live",
      t6: (watchers: string, recovery: string) =>
        `The Guardian Watcher holding the key of ${watchers} stays live and uncompromised. If it is down, alerts and duress Clawbacks stop, but G-1 still holds and human Guardians can still claw back; the Deployment watcher line on this page shows when it was last seen. If it is compromised, it can claw back to ${recovery} only: theft also needs the MPC network (T-3).`,
    },
    residual: (delay: string) =>
      `This Vault has no Auto-Clawback Guardian, so a Recovery Address change is stopped only by a Guardian veto within ${delay}.`,
    /**
     * The in-browser address recompute (story 6.2): the script `get_vault_kit` publishes,
     * decoded and hashed here, against what `get_vault` states.
     */
    recompute: {
      action: "Recompute",
      reading: "Reading the Vault Kit",
      intro:
        "Recompute the Vault Address in this browser: decode the script get_vault_kit publishes, hash it with sha256 and encode the P2WSH address, then check it against get_vault.",
      failed: "Could not read the Vault Kit",
      failedBody:
        "The NEAR RPC did not answer get_vault_kit with a Vault Kit. Nothing was computed.",
      retry: "Retry",
      noScript: "This Vault has no script yet, so there is nothing to recompute.",
      vaultAddress: "Vault Address",
      allowanceAddress: "Allowance Address",
      allowanceToggle: "Recompute the Allowance Address",
      addressCheck: "Address check",
      scriptCheck: "Script check",
      match: "Match",
      noMatch: "No match",
      matches: (what: string) => `matches the funded ${what}`,
      noMatchText: (what: string) => `does not match the funded ${what}`,
      recomputed: "Recomputed in this browser",
      funded: (what: string) => `Funded ${what}, from get_vault`,
      scriptOk: (guardians: number, blocks: string) =>
        `The script encodes the Owner key, the Co-signer key, ${plural(guardians, "Guardian key")} in Policy order and the Escape Timelock of ${blocks}, as get_vault states them.`,
      scriptBad: (element: string) =>
        `${element}: the script does not encode the keys and timelock get_vault states.`,
      atByte: (at: number) => `at byte ${at}`,
      differs: (name: string) => `${name} differs`,
      missingElement: (name: string) => `${name} is missing`,
      extra: (name: string) => `an extra ${name} after the template's end`,
      unreadableKeys: "The keys get_vault states could not be read as keys",
      kitCheck: "Kit agrees with get_vault",
      kitAgrees:
        "yes. Its Co-signer keys, Bitcoin network, addresses and Escape Timelock are the ones get_vault states.",
      kitDisagrees: (fields: string) => `no. It differs on ${fields}.`,
      mismatch: {
        vault: "Vault",
        allowance: "Allowance",
        cosigner: (which: string) => `${which} Co-signer key`,
        network: "Bitcoin network",
        address: (which: string) => `${which} Address`,
        timelock: "Escape Timelock",
      },
      branches: {
        if: "IF",
        notif: "NOTIF (inverted)",
        else: "ELSE",
        endif: "ENDIF",
        unexpected: (name: string) => `${name} unexpected`,
      },
      flip: "Flip a byte",
      reset: "Reset",
      flipHint: (at: number) =>
        `Flip a byte changes byte ${at}, the last byte of the Owner key, by XOR 0x01. Select any byte below to flip it.`,
      flippedNote: (count: number) => `${plural(count, "byte")} flipped in this browser only.`,
      paths: "Paths",
      pathNames: { withdrawal: "Withdrawal", clawback: "Clawback", escape: "Escape" },
      pathRules: (threshold: number, guardians: number, blocks: string) => ({
        withdrawal: "Owner + Co-signer",
        clawback: `Co-signer + ${threshold} of ${plural(guardians, "Guardian")}`,
        escape: `Owner after the CSV of ${blocks}`,
      }),
      decoded: (size: number) => `Decoded script · ${plural(size, "byte")}`,
      bytes: "Bytes · select one to flip it",
      rowDiffers: "differs from the template",
      bytesLabel: "Script bytes",
      byteLabel: (at: number, hex: string, flipped: boolean) =>
        `Byte ${at}: ${hex}${flipped ? ", flipped" : ""}`,
      offset: (at: number) => String(at).padStart(3, "0"),
      roles: {
        owner: "Owner key",
        cosigner: "Co-signer key",
        guardian: (n: number, account: string) =>
          account === "" ? `Guardian key ${n}` : `Guardian key ${n} · ${account}`,
        threshold: (count: number) => `${plural(count, "Guardian signature")} needed`,
        guardianCount: (count: number) => `${plural(count, "Guardian key")} in all`,
        timelock: (blocks: string) => `Escape Timelock · ${blocks}`,
      },
      matchesShort: (what: string) => `the recomputed address matches the funded ${what}`,
      noMatchShort: (what: string) => `the recomputed address does not match the funded ${what}`,
      scriptOkShort: "the script encodes the keys and timelock get_vault states",
      announce: (what: string, address: string, script: string) =>
        `${what} recomputed: ${address}. Script check: ${script}.`,
      announceFlip: (at: number, address: string, script: string) =>
        `Byte ${at} flipped: ${address}. Script check: ${script}.`,
      announceReset: (address: string, script: string) =>
        `Reset to the published script: ${address}. Script check: ${script}.`,
    },
  },

  /**
   * The wallet pages (story 1.11b): `/vault/new` creates a Vault, `/vault/<id>` operates it. A
   * NEAR wallet signs every contract call; the Bitcoin keys stay in the page.
   */
  vault: {
    copy: "Copy",
    copied: "Copied",
    diagram: {
      caption: (delay: string) =>
        `A withdrawal request waits ${delay} in public before NEAR co-signs it. During that wait, Claw back sends the coins to the safe address instead.`,
      request: "request",
      waits: (delay: string) => `waits ${delay}`,
      cosign: "co-sign",
      near: "NEAR",
      clawback: "Claw back, any time before",
      noRecovery: "your safe address",
    },
    unsupported: "The wallet pages need NEAR testnet and Bitcoin signet",
    unsupportedBody:
      "This deployment runs on other networks. Vaults are created from the web app on NEAR testnet with Bitcoin signet only: no mainnet, no regtest.",
    loadFailed: "The Vault page could not be loaded",
    loadFailedBody:
      "Part of the wallet page did not download, often because a new version was deployed. Reload to get it. Nothing was sent.",
    noNonce: "This page was served without its wallet nonce, so no wallet can load. Reload it.",
    reload: "Reload",
    wallet: {
      title: "NEAR wallet",
      connect: "Connect a NEAR wallet",
      connecting: "Opening the wallet",
      stepTitle: "Connect your NEAR wallet",
      connected: (account: string) => `Connected as ${account}`,
      disconnect: "Disconnect",
      hint: "Meteor Wallet or Intear Wallet, on NEAR testnet. Your wallet approves each step on NEAR. The Bitcoin keys are made in this page and never leave it.",
      loadFailed: (message: string) =>
        `The wallet could not load or connect: ${message}. Check the connection and try again.`,
      retry: "Try again",
    },
    create: {
      title: "Create a Vault",
      free: "Free test coins",
      lede: "Lock test bitcoin behind a waiting time that a NEAR contract enforces, then stop a pretend theft yourself. About five minutes and two wallet approvals.",
      howSteps: [
        {
          title: "Put bitcoin in",
          body: "Coins sit at a Bitcoin address that needs your key and the NEAR contract's signature.",
        },
        {
          title: "Every withdrawal waits",
          body: "A withdrawal is public for the waiting time. NEAR will not co-sign it before then, whoever asks.",
        },
        {
          title: "Claw back sends it home",
          body: "While it waits, one tap sends every coin to your safe address. A thief with your keys gets nothing.",
        },
      ],
      previewEyebrow: "Your Vault",
      draft: "draft",
      preview: {
        owner: "Owner",
        guardian: "Guardian",
        delay: "Waiting time",
        recovery: "Safe address",
        keys: "Key file",
        none: "not set",
        notSaved: "not saved",
      },
      savedShort: "saved",
      generateTitle: "No signet wallet?",
      delayTitle: "Choose the waiting time",
      delayLegend:
        "Every withdrawal waits this long, in public, before the NEAR contract signs it. This is the time you have to stop a thief.",
      delays: {
        "1h": { label: "1 hour", note: "For trying it out" },
        "24h": { label: "24 hours", note: "For real use" },
      },
      detailsSummary: "All the Vault's rules",
      policyFacts:
        "Policy Change Delay 7 days · Escape Timelock 4,320 blocks · Fee Cap 100,000 sats · Spending Allowance 10,000 sats per 24 hours · at most 5 coins per withdrawal or Clawback · Fast Approval off · one Backup Device Guardian: the connected account",
      recoveryTitle: "Choose where rescued coins go",
      recoveryLabel: "Your safe address (the Recovery Address, on signet)",
      recoveryHint:
        "Claw back sends the coins here and nowhere else. It is written into the Vault, so a thief cannot change it. Paste a signet address you control (tb1…), or let this page make one.",
      generate: "Make a test address for me",
      generateNote:
        "This page makes a test address and puts its key in your key file. Connect your wallet first.",
      addressProblem: {
        malformed: "This is not a valid SegWit address.",
        network: "This is not a signet address.",
        version: "The Vault pays SegWit v0 and Taproot addresses only.",
        program: "This address has a witness program the Vault does not accept.",
      },
      retypeLabel: "To confirm it, type the address's last 6 characters",
      retypeMismatch: "These are not the last 6 characters of the Recovery Address.",
      keysTitle: "Save your key file",
      keysBody:
        "This page made your Vault's Bitcoin keys (the Owner Key and the Guardian Key). The file is their only copy: download it before you create the Vault, and keep it private. The Vault page asks for it if you come back later.",
      download: "Download key file",
      downloaded:
        "Key file downloaded. Keep it safe: anyone with it and this NEAR account can sign for the Vault.",
      missingTitle: "Still to do",
      missing: {
        wallet: "Connect a NEAR wallet.",
        address: "Enter a signet Recovery Address.",
        retype: "Re-type the last 6 characters of the Recovery Address.",
        download: "Download the key file.",
        reload: "Reload the page to draw new keys: a Vault may exist for these.",
      },
      submit: "Create Vault",
      createTitle: "Create the Vault",
      cost: "Your wallet asks you to approve one transaction. It pays 0.5 testnet NEAR for the Vault's storage on NEAR.",
      waitingWallet: "Waiting for the wallet to sign create_vault",
      activating: (id: string) =>
        `Vault #${id} created. Waiting for NEAR to show it active with its Co-signer keys.`,
      active: (id: string) => `Vault #${id} is active. Opening its page.`,
      notActive: (id: string) =>
        `Vault #${id} was created but NEAR does not show it active yet. Open its page to read it again.`,
      openVault: (id: string) => `Open Vault #${id}`,
      noVaultId:
        "The wallet sent create_vault, but its answer has no Vault id: the Vault may exist. Check this account's transactions before you try again.",
      maybeCreated:
        "The wallet may have sent create_vault, but its answer could not be read: the Vault may exist. Check this account's transactions before you try again.",
      viewTx: "View the transaction on NearBlocks",
      invalidPolicy: (code: string) => `The Policy was refused before sending · ${code}`,
    },
    page: {
      title: (id: string) => `Vault #${id}`,
      guideTitle: "Try it: stop a theft in 3 steps",
      guide: {
        fund: {
          title: "Put test bitcoin in",
          body: "Copy the Vault Address and get free signet coins from the faucet. One confirmation takes about 10 minutes; this page checks every 30 seconds.",
        },
        request: {
          title: "Play the thief: ask to withdraw",
          body: "Request a withdrawal to any signet address, as a thief holding your keys would. The request is public, and NEAR will not sign it before the waiting time ends.",
        },
        clawback: {
          title: "Send the coins home",
          body: "Press Claw back. The coins go to your safe address, the request is cancelled, and the thief gets nothing. The Vault then closes.",
        },
        honest:
          "An honest withdrawal works the same way without step 3: wait out the time, then press Execute.",
        status: { done: "done", next: "next", later: "" },
        doneAll:
          "Done: the theft was stopped. The coins are at your safe address. Create another Vault to try again.",
        again: "Create another Vault",
      },
      loading: "Reading the Vault from NEAR",
      unreachable: "NEAR is not answering",
      unreachableBody: "The Vault could not be read. Nothing was sent.",
      notSignet:
        "This Vault is not on Bitcoin signet. The wallet pages operate signet Vaults only.",
      retry: "Retry",
      factsTitle: "This Vault's rules",
      facts: {
        owner: "Owner Account",
        guardian: "Guardians",
        delay: "Delay",
        recovery: "Recovery Address",
      },
      states: {
        pending_keys: "pending keys",
        active: "active",
        clawed_back: "clawed back",
      },
      proof: "Open its Proof Page",
      addressTitle: "Vault Address",
      fundTitle: "Put test bitcoin in",
      heldTitle: "Held in this Vault",
      copyAddress: "Copy the Vault Address",
      delayChip: (delay: string) => `waiting time ${delay}`,
      stepLabel: (n: number) => `step ${n}`,
      clawedTitle: "Clawed back",
      clawedBody:
        "Every coin went to the safe address below, and the Vault is closed for good. No request can execute any more.",
      addressPending: "The Vault has no address until its Co-signer keys are stored.",
      balance: (btc: string) => `${btc} BTC on signet`,
      balanceUnit: "BTC on signet",
      unconfirmed: (btc: string) => `${btc} BTC not confirmed yet`,
      tip: (height: string) => `Signet tip block ${height}`,
      unfunded:
        "No coins yet. Fund it from a signet faucet, then wait for one confirmation. The actions open once a coin is confirmed.",
      faucet: "Open a signet faucet",
      btcUnreachable: "The Bitcoin backend is not answering, so the Vault's coins are unknown.",
      keysTitle: "Key file",
      keysBody:
        "Your keys sign the Bitcoin side of each action. Right after you create a Vault they are already loaded. If you come back later, load the key file you saved: it stays in this page's memory, never sent, never stored.",
      loadKeys: "Load key file",
      keysLoaded: "Keys loaded for this Vault.",
      downloadKeys: "Download key file with the Vault id",
      keyProblem: {
        format: "Refused: this is not a Morrow Vault key file. Nothing was sent.",
        key: "Refused: a key in this file is not valid. Nothing was sent.",
        network:
          "Refused: this key file is for another network or Vault Contract. Nothing was sent.",
        vault: "Refused: this key file is for another Vault. Nothing was sent.",
        account: "Refused: this key file is for another Owner Account. Nothing was sent.",
        "owner-key": "Refused: this key file's Owner Key is not this Vault's. Nothing was sent.",
        "guardian-key":
          "Refused: this key file's Guardian Key is not one of this Vault's. Nothing was sent.",
      },
      gates: {
        wallet: "Connect a NEAR wallet first.",
        owner: (account: string) => `Only the Owner Account, ${account}, can do this.`,
        guardian: "The connected account is not a Guardian of this Vault.",
        keys: "Load the key file first.",
        funds: "The Vault Address has no confirmed coins.",
        coins: "Reading the Vault's coins.",
        closed: "The Vault was clawed back to its Recovery Address and is closed.",
        notActive: "The Vault is not active yet.",
        busy: "Another action is running.",
      },
      request: {
        title: "Request a withdrawal",
        stepTitle: "Play the thief: ask to withdraw",
        body: "Any signet address will do. The request waits in public for the waiting time. Until then, Claw back can stop it.",
        destination: "Destination (signet address)",
        amount: "Amount in sats",
        max: (sats: string) => `At most ${sats} sats from the confirmed coins, after the fee.`,
        submit: "Request withdrawal",
        amountProblem: "Enter whole sats between 546 and the most shown.",
        fundsProblem: "The confirmed coins do not cover a withdrawal and its fee.",
        sealProblem: "The Watcher Envelope could not be sealed. Nothing was sent.",
      },
      pending: {
        title: "Withdrawal Request",
        stepTitle: "The open request",
        ready: "Ready",
        left: "left",
        progress: "Waiting time passed",
        nothing: "Nothing is waiting",
        stopHint: "Claw back can still stop it.",
        byOp: "Open a request by its op id",
        none: "No request is open in this page. Open one by its op id, or request a withdrawal.",
        opLabel: "Op id",
        open: "Open request",
        badOp: "Enter the op id of a withdrawal of this Vault.",
        notThisVault: "That op is not a withdrawal of this Vault.",
        summary: (op: string, sats: string, destination: string) =>
          `Op #${op} · ${sats} sats to ${destination}`,
        state: (state: string) => `State: ${state}`,
        executableAt: (at: string) => `Executable from ${at}`,
        execute: "Execute",
        notYet: (at: string) => `Execute opens at ${at}.`,
        notPending: "This request is no longer pending.",
      },
      clawback: {
        title: "Claw back",
        stepTitle: "Send the coins home",
        to: "to",
        body: "Sends the Vault's coins (up to 5) to your safe address. It cancels every open request and closes the Vault for good. Your wallet approves it, and this page signs the Bitcoin side with your Guardian Key.",
        submit: "Claw back",
        resumeNote: (op: string) =>
          `Clawback op #${op} is started but not on Bitcoin. Claw back carries it on without starting another.`,
        rebroadcast: "Broadcast again",
      },
      steps: {
        wallet: (method: string) => `Waiting for the wallet to sign ${method}`,
        signInput: (input: string, inputs: string) =>
          `Waiting for the wallet to sign sign_input, input ${input} of ${inputs}`,
        reading: "Reading NEAR",
        broadcasting: "Broadcasting to Bitcoin signet",
      },
      outcome: {
        requested: (op: string, at: string) =>
          `Withdrawal Request op #${op} accepted. It is pending until ${at}. Note op #${op}: to execute it after the Delay, open it here by its op id.`,
        requestedNoTime: (op: string) =>
          `Withdrawal Request op #${op} accepted. Note op #${op}: to execute it after the Delay, open it here by its op id.`,
        failed: (message: string) =>
          `The action stopped with an error: ${message}. Read the Vault again before you retry.`,
        broadcast: (txid: string) => `On Bitcoin signet: ${txid}`,
        viewTx: "View the transaction on mempool.space",
        refused: (code: string, meaning: string) => `Refused · ${code} · ${meaning}`,
        refusedRaw: (message: string) => `Refused by NEAR · ${message}`,
        rejected: (message: string) => `The wallet did not send it: ${message}`,
        unreadable:
          "The wallet sent it, but NEAR's answer could not be read. Read the Vault again before you retry.",
        broadcastFailed: (message: string) =>
          `The Bitcoin backend did not take the transaction: ${message}`,
        broadcastUnreachable: "The Bitcoin backend did not answer. Nothing was broadcast.",
      },
    },
  },

  /**
   * The Lost a device page (story 3.8, FR-31). Static: it reads no chain data and needs no
   * sign-in or key. It names only what this build has, and says so where a screen is missing.
   */
  lost: {
    intro:
      "If a device that holds your Owner Key or signs for your Owner Account is lost or stolen, treat those keys as compromised. The Delay is the time you have to act.",
    stepsTitle: "What to do, in order",
    steps: {
      clawback: {
        title: "Ask any Guardian to Clawback",
        body: "One Guardian is enough. A Clawback pays the Recovery Address only. The first one voids every live request, vetoes a pending Policy Change and closes the Vault for good. The Owner cannot cancel it, so a thief with the Owner keys cannot either. Afterwards every request fails with ERR_CLAWED_BACK.",
        build:
          "In this build a Guardian claws back by calling begin_clawback on the Vault Contract, shown end to end by Scenario S-3. Each call sweeps up to 5 coins from one source, the Vault Address by default or the Allowance Address, so the Guardian repeats it for each source until every coin is at the Recovery Address. On a signet Vault made in this web app, the Vault page has a Claw back button that does this.",
      },
      backup: {
        title: "Claw back from your own Backup Device",
        body: "If one of your Guardians is a Backup Device you still hold, it can claw back by itself: the same call, with the same result.",
        build:
          "In this build the Backup Device's Guardian account makes the same begin_clawback call. A signet Vault made in this web app uses your own NEAR account as its Backup Device Guardian, so its Claw back button is this step.",
      },
      fresh: {
        title: "Create a new Vault",
        body: "Once the coins are at the Recovery Address, create a new Vault with new keys. Never reuse the Owner Key or the Owner Account of the compromised one.",
        build:
          "In this build you create your own Vault at /vault/new, on NEAR testnet with Bitcoin signet test coins.",
      },
    },
    guardianTitle: "Reaching a Guardian",
    guardian:
      "Call or message your Guardians directly, the way you agreed when you set up the Vault. Any one of them can claw back. Their accounts are in the Vault's Policy, which the Proof Page reads from the chain for any Vault id.",
    guardianAlert:
      "A withdrawal request is public, and on a Vault with a Guardian Watcher it alerts the Guardians on Telegram, so they may already be watching.",
    guardianNoAnswer:
      "If no Guardian answers, keep trying them: a thief still waits the Delay. On a Vault with a Guardian Watcher every request also alerts you on Telegram, which you can open from another device to keep asking your Guardians for help.",
    thiefTitle: "What a thief can and cannot do during the Delay",
    canTitle: "With your Owner keys, a thief can",
    can: {
      withdraw:
        "Request a withdrawal. The request is public, waits the Delay and, on a Vault with a Guardian Watcher, alerts the Guardians on Telegram.",
      allowance: "Spend the Spending Allowance up to its 24 h limit. It has no Delay, by design.",
      policy:
        "Propose a Policy Change. It waits the Policy Change Delay, and any Guardian can veto it.",
      escape:
        "After a coin's Escape Timelock, spend it with the Owner Key alone, with no Delay. A Clawback before then, and a routine Refresh, keep that from happening.",
    },
    cannotTitle: "A thief cannot",
    cannot: {
      execute: "Execute a withdrawal before the Delay ends.",
      stop: "Stop a Clawback.",
      redirect: "Redirect a Clawback: it pays the Recovery Address only.",
      script: "Change the Script-bound fields, such as the Guardians and the Escape Timelock.",
    },
    escapeTitle: "Escape and Refresh",
    escape: {
      title: "Escape with the Vault Kit",
      body: "If NEAR or the Co-signer stops, tools/escape signs a spend offline with the Vault Kit and the Owner Key after the Escape Timelock. It uses no NEAR. Scenario S-5 runs it.",
    },
    refresh: {
      title: "Refresh",
      body: "After a coin's Escape Timelock, the Owner Key alone can spend it, so a thief holding that key could too. That is why Refresh exists: refresh re-locks coins to the Vault Address and resets the Escape Timelock. A Clawback before then moves the coins out of reach.",
      build: "Refresh is a contract call; it has no screen yet.",
    },
    linksTitle: "Read more",
    links: {
      scenarios: "Scenarios in the README",
      trust: "Trust model in the README",
      escape: "tools/escape on GitHub",
    },
    openProof: "Open the Proof Page",
    /** The accessible name of a link that opens in a new tab. */
    newTab: (text: string) => `${text} (opens in a new tab)`,
  },

  notFound: {
    body: (path: string) => `Nothing lives at ${path}.`,
    link: "Open Challenge",
  },

  /** The banner line, or null only when both sides are mainnet. */
  networkBanner: ({ btc, near }: NetworkPair): string | null => {
    if (btc === "bitcoin") {
      return near === "mainnet" ? null : `Real bitcoin · ${NEAR_SIDE[near]} · test deployment`;
    }
    return `${BTC_COINS[btc]} test coins · ${NEAR_SIDE[near]} · not real bitcoin`;
  },

  /** The network line of the sidebar system card, e.g. `signet · NEAR testnet`. */
  systemNetwork: ({ btc, near }: NetworkPair) => `${btc} · ${NEAR_SIDE[near]}`,
} as const;
