// The wallets the wallet pages offer, as a local near-connect manifest: Meteor Wallet and
// Intear Wallet, both of which support NEAR testnet. Each entry is the hot-dao/near-selector
// repository manifest's (v1.1.0, fetched 2026-11-12 from
// https://raw.githubusercontent.com/hot-dao/near-selector/refs/heads/main/repository/manifest.json)
// with two changes: `executor` points at a pinned copy served from our own origin, and `icon`
// is a data URI. So no page loads script from a third-party origin; the wallet pages run the
// pinned wallet code below, which near-connect injects into a sandboxed iframe with the
// page's CSP nonce. `server/wallets.test.ts` checks each copy against its sha256.

export interface PinnedExecutor {
  /** Where the copy is served, relative to our origin. */
  path: string;
  /** Where it was fetched from. */
  source: string;
  /** sha256 of the copy, hex. */
  sha256: string;
}

export const PINNED_EXECUTORS = {
  meteor: {
    path: "/wallets/meteor.js",
    source:
      "https://raw.githubusercontent.com/Meteor-Wallet/meteor_wallet_sdk/data-storage/storage/meteor-near-connect-latest.js",
    sha256: "e1795611500188077a6eadd5597b03b840f6d530f5e2904b621b378f8e007c73",
  },
  intear: {
    path: "/wallets/intear.js",
    source: "https://wallet.intear.tech/near-selector.js",
    sha256: "6decc283352af197feff4988628899d19e05f4168a4277fe699bd8a0d6178e34",
  },
} as const satisfies Record<string, PinnedExecutor>;

/** The Meteor icon (meteor_wallet_sdk assets/meteor-logo-svg.svg) as a data URI. */
const METEOR_ICON =
  "data:image/svg+xml;base64,PHN2ZyBkYXRhLW5hbWU9IkxheWVyIDEiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyIgeG1sbnM6eGxpbms9Imh0dHA6Ly93d3cudzMub3JnLzE5OTkveGxpbmsiIHZpZXdCb3g9IjAgMCA0MDAuMDQgNDAwLjA0Ij4KICA8ZGVmcz4KICAgIDxsaW5lYXJHcmFkaWVudCBpZD0iYSIgeDE9IjIxNS4zOSIgeTE9IjIzOS40NyIgeDI9IjM4Mi4zOCIgeTI9IjIzOS40NyIgZ3JhZGllbnRUcmFuc2Zvcm09InRyYW5zbGF0ZSgtMTIyLjk2IC0xNDguMTYpIiBncmFkaWVudFVuaXRzPSJ1c2VyU3BhY2VPblVzZSI+CiAgICAgIDxzdG9wIG9mZnNldD0iLjA3IiBzdG9wLWNvbG9yPSIjMGYwZjM2Ii8+CiAgICAgIDxzdG9wIG9mZnNldD0iLjc2IiBzdG9wLWNvbG9yPSIjMjMyMzcxIi8+CiAgICA8L2xpbmVhckdyYWRpZW50PgogICAgPGxpbmVhckdyYWRpZW50IGlkPSJiIiB4MT0iMjg1LjQ5IiB5MT0iMzM1LjA0IiB4Mj0iNDY5LjQ0IiB5Mj0iMzM1LjA0IiBncmFkaWVudFRyYW5zZm9ybT0idHJhbnNsYXRlKC03OC40IC0yMzEuNzEpIiBncmFkaWVudFVuaXRzPSJ1c2VyU3BhY2VPblVzZSI+CiAgICAgIDxzdG9wIG9mZnNldD0iMCIgc3RvcC1jb2xvcj0iIzBmMGYzNiIvPgogICAgICA8c3RvcCBvZmZzZXQ9Ii44IiBzdG9wLWNvbG9yPSIjMjMyMzcxIi8+CiAgICA8L2xpbmVhckdyYWRpZW50PgogICAgPGxpbmVhckdyYWRpZW50IGlkPSJjIiB4MT0iMjk4Ljk5IiB5MT0iNDI4LjQ5IiB4Mj0iMzY2Ljc0IiB5Mj0iNDI4LjQ5IiBncmFkaWVudFRyYW5zZm9ybT0idHJhbnNsYXRlKC43NCAtMjI3LjU0KSIgeGxpbms6aHJlZj0iI2EiLz4KICAgIDxsaW5lYXJHcmFkaWVudCBpZD0iZCIgeDE9IjM2LjYiIHkxPSIzMzIuOTIiIHgyPSI0MzEuNjIiIHkyPSIzMzIuOTIiIGdyYWRpZW50VHJhbnNmb3JtPSJyb3RhdGUoLTQ1IDU4LjU2IDMxMy44MykiIGdyYWRpZW50VW5pdHM9InVzZXJTcGFjZU9uVXNlIj4KICAgICAgPHN0b3Agb2Zmc2V0PSIwIiBzdG9wLWNvbG9yPSIjNDc5ZmY1Ii8+CiAgICAgIDxzdG9wIG9mZnNldD0iLjIyIiBzdG9wLWNvbG9yPSIjNDA1ZWU1Ii8+CiAgICAgIDxzdG9wIG9mZnNldD0iLjM1IiBzdG9wLWNvbG9yPSIjNTIzYmRhIi8+CiAgICAgIDxzdG9wIG9mZnNldD0iLjQzIiBzdG9wLWNvbG9yPSIjNWE1NWNlIi8+CiAgICAgIDxzdG9wIG9mZnNldD0iLjU2IiBzdG9wLWNvbG9yPSIjNWE1NWNlIi8+CiAgICAgIDxzdG9wIG9mZnNldD0iLjc2IiBzdG9wLWNvbG9yPSIjM2IzY2JiIi8+CiAgICAgIDxzdG9wIG9mZnNldD0iLjg3IiBzdG9wLWNvbG9yPSIjMTcxZTliIi8+CiAgICAgIDxzdG9wIG9mZnNldD0iMSIgc3RvcC1jb2xvcj0iIzE3MWU5YiIvPgogICAgPC9saW5lYXJHcmFkaWVudD4KICA8L2RlZnM+CiAgPHBhdGggZD0iTTEwNSA2NS4yOWgxMjguMzlhMjYgMjYgMCAwIDEgMjYgMjYgMjYgMjYgMCAwIDEtMjYgMjZIMTA1YTEyLjU0IDEyLjU0IDAgMCAxLTEyLjU3LTEyLjQ5di0yN0ExMi41NCAxMi41NCAwIDAgMSAxMDUgNjUuMjlaIiB0cmFuc2Zvcm09InJvdGF0ZSgtNDUgMTc1LjkyIDkxLjMxKSIgZmlsbD0idXJsKCNhKSIvPgogIDxwYXRoIGQ9Ik0yMjAuMiA3Ni43NGgxNDQuMjRBMjYuNTkgMjYuNTkgMCAwIDEgMzkxIDEwMy4zM2EyNi41OSAyNi41OSAwIDAgMS0yNi41OSAyNi41OUgyMjAuMmExMy4xMSAxMy4xMSAwIDAgMS0xMy4xMS0xMy4xMXYtMjdhMTMuMTEgMTMuMTEgMCAwIDEgMTMuMTEtMTMuMDdaIiB0cmFuc2Zvcm09InJvdGF0ZSgtNDUgMjk5LjA2IDEwMy4zMykiIGZpbGw9InVybCgjYikiLz4KICA8cmVjdCB4PSIyOTkuNzMiIHk9IjE3Ni45IiB3aWR0aD0iNjcuNzUiIGhlaWdodD0iNDguMDgiIHJ4PSIyNC4wNCIgdHJhbnNmb3JtPSJyb3RhdGUoLTQ1IDMzMy42IDIwMC45NSkiIGZpbGw9InVybCgjYykiLz4KICA8cGF0aCBkPSJtMzM5LjA5IDk5LjM1LTY0LjggNjQuOGEyNS41IDI1LjUgMCAwIDEtMzYuMDUgMCAyNS40OSAyNS40OSAwIDAgMSAwLTM2TDI1MiAxMTQuMzdjOC42OC04LjY5IDkuMzMtMjIuOTMuODEtMzEuNzdhMjIuMyAyMi4zIDAgMCAwLTMxLjgxLS4yOWwtNjAuODIgNjAuODNhMjUuNDkgMjUuNDkgMCAwIDEtMzYgMCAyNS41IDI1LjUgMCAwIDEgMC0zNi4wNmwyMC4yNi0yMC4yN2EyMi4zMSAyMi4zMSAwIDAgMC0uMy0zMS44M2MtOC44NC04LjUyLTIzLjA4LTcuODYtMzEuNzYuODJsLTU1IDU1Yy0uMjYuMjUtLjQ4LjUzLS43Mi43OUExNjMuNTMgMTYzLjUzIDAgMCAwIDI4Ny44IDM0Mi44NmwtLjItLjJjLjI2LS4yNC41My0uNDYuNzktLjcybDk3LjA5LTk3LjA5YzguNjgtOC42OCA5LjM0LTIyLjkyLjgxLTMxLjc2YTIyLjMxIDIyLjMxIDAgMCAwLTMxLjgzLS4zczE4LjE4LTE4LjE1LTkuOCA5Ljg2YTIzLjI1IDIzLjI1IDAgMCAxLTMyLjkgMCAyMy4yNSAyMy4yNSAwIDAgMSAwLTMyLjlsNTkuMzktNTkuMzlhMjIuMzEgMjIuMzEgMCAwIDAtLjMtMzEuODNjLTguODUtOC41My0yMy4wOC03Ljg2LTMxLjc2LjgyWiIgZmlsbD0idXJsKCNkKSIvPgogIDxyZWN0IHg9IjYyLjU5IiB5PSI5NC4zNCIgd2lkdGg9IjUwLjk3IiBoZWlnaHQ9IjI1LjQ5IiByeD0iMTIuNzQiIHRyYW5zZm9ybT0icm90YXRlKC00NSA4OC4wNyAxMDcuMSkiIGZpbGw9IiNhNGExZWYiLz4KICA8Y2lyY2xlIGN4PSIxMjQuMTEiIGN5PSI3MS4wNCIgcj0iMTIuNzQiIGZpbGw9IiNjMmJmZmMiLz4KICA8cmVjdCB4PSIyMDguNjIiIHk9Ijg5Ljg0IiB3aWR0aD0iMzguMjMiIGhlaWdodD0iMjUuNDkiIHJ4PSIxMi43NCIgdHJhbnNmb3JtPSJyb3RhdGUoLTQ1IDIyNy43NCAxMDIuNTgpIiBmaWxsPSIjNzg2YmVlIi8+Cjwvc3ZnPgo=";

/** near-connect's manifest shape, as `NearConnector({ manifest })` takes it. */
export const WALLET_MANIFEST = {
  version: "1.1.0",
  wallets: [
    {
      id: "meteor-wallet",
      name: "Meteor Wallet",
      icon: METEOR_ICON,
      description:
        "The most simple and secure wallet to manage your crypto, access DeFi, and explore Web3",
      website: "https://meteorwallet.app/",
      version: "1.1.1",
      executor: PINNED_EXECUTORS.meteor.path,
      type: "sandbox",
      features: {
        signMessage: true,
        signInWithoutAddKey: true,
        signInAndSignMessage: true,
        signAndSendTransaction: true,
        signAndSendTransactions: true,
        signInWithFunctionCallKey: true,
        signDelegateActions: true,
        mainnet: true,
        testnet: true,
      },
      platform: {
        web: "https://wallet.meteorwallet.app",
        chrome:
          "https://chromewebstore.google.com/detail/meteor-wallet/pcndjhkinnkaohffealmlmhaepkpmgkb",
        android: "https://play.google.com/store/apps/details?id=app.meteorwallet.v2",
        ios: "https://apps.apple.com/us/app/meteor-wallet/id6739558223",
      },
      permissions: {
        storage: true,
        allowsOpen: [
          "https://chromewebstore.google.com",
          "https://wallet.meteorwallet.app",
          "https://meteorwallet.app",
          "meteorwallet://",
          "meteorwalletdev://",
        ],
        external: ["meteorCom", "meteorComV2"],
      },
    },
    {
      id: "intear-wallet",
      name: "Intear Wallet",
      icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='49.152' height='49.152' viewBox='0 0 36.864 36.864' fill='%230079fb'><path d='M18.487 32.306c-4.599.067-8.487-3.315-9.181-7.846-.278-1.81.068-3.077.628-4.791 1.403-4.291 3.971-8.695 6.427-12.51l.949-1.478c.309-.484.487-1.03 1.115-1.125.512.052.64.423.897.807 2.484 3.706 8.36 13.272 8.334 17.704-.029 5.044-4.068 9.27-9.169 9.238zm-.063-25.712c-2.557 3.771-4.933 7.827-6.631 12.055-.838 2.086-1.485 3.738-1.052 5.983.693 3.599 3.997 6.409 7.684 6.303 4.346.06 7.767-3.49 7.827-7.766.042-2.97-3.226-9.081-4.764-11.757-.373-.65-2.709-4.575-3.064-4.818zM13.18 24.15c-.768.067-.771-.701-.769-1.27.004-1.585.41-2.564.69-3.114.179-.512.807-1.39 1.38-1.807.334-.208.836-.51 1.137-.21.362.547.163.6-.06.906a6.14 6.14 0 0 0-1.754 4.195c-.003.577.098 1.181-.625 1.299zm7.543 5.012c-.598-.034-.626-.334-.735-.811.143-.444.303-.695.753-.698 1.166-.664 2.362-1.655 2.564-3.328.194-.569.104-1.219.864-1.332.852 0 .743 1.326.622 1.885-.923 2.883-2.483 3.648-4.068 4.284z'/></svg>",
      description: "A fast and secure wallet for everyday interactions with dapps",
      website: "https://intea.rs/",
      version: "1.0.0",
      executor: PINNED_EXECUTORS.intear.path,
      type: "sandbox",
      features: {
        signMessage: true,
        signTransaction: false,
        signAndSendTransaction: true,
        signAndSendTransactions: true,
        signInWithoutAddKey: true,
        verifyOwner: false,
        testnet: true,
        signDelegateActions: true,
        signInAndSignMessage: true,
        signInWithFunctionCallKey: true,
      },
      platform: {
        web: "https://wallet.intear.tech",
      },
      permissions: {
        storage: true,
        location: true,
        allowsOpen: [
          "https://wallet.intear.tech",
          "https://staging.wallet.intear.tech",
          "http://intearwallet.local",
          "https://intearwallet.local",
          "http://intearwallet.localhost:3000",
          "intear://",
          "https://logout-bridge-service.intear.tech",
        ],
      },
    },
  ],
};
