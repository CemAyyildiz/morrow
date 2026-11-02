export interface ScenarioContext {
  /** Prints a progress line under the Scenario. */
  log(message: string): void;
}

export interface Scenario {
  id: `S-${number}`;
  name: string;
  /** Mandatory Scenarios may never be skipped in a release build. */
  mandatory: boolean;
  /** Absent until the feature is built. Throwing means FAIL. */
  run?: (ctx: ScenarioContext) => Promise<void>;
}

export const SCENARIOS: Scenario[] = [
  { id: "S-1", name: "Create", mandatory: true },
  { id: "S-2", name: "Withdraw after Delay", mandatory: true },
  { id: "S-3", name: "Thief and Clawback", mandatory: true },
  { id: "S-4", name: "Duress", mandatory: false },
  { id: "S-5", name: "Escape", mandatory: true },
  { id: "S-6", name: "Policy Change", mandatory: false },
  { id: "S-7", name: "Fast Approval", mandatory: false },
];
