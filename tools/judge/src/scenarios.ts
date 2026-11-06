import { runCreate } from "./scenarios/s1-create.js";
import { runWithdraw } from "./scenarios/s2-withdraw.js";
import { runThief } from "./scenarios/s3-thief.js";
import { runEscapeScenario } from "./scenarios/s5-escape.js";
import { runPolicyChange } from "./scenarios/s6-policy.js";
import { runFastApproval } from "./scenarios/s7-fast.js";

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
  { id: "S-1", name: "Create", mandatory: true, run: runCreate },
  { id: "S-2", name: "Withdraw after Delay", mandatory: true, run: runWithdraw },
  { id: "S-3", name: "Thief and Clawback", mandatory: true, run: runThief },
  { id: "S-4", name: "Duress", mandatory: false },
  { id: "S-5", name: "Escape", mandatory: true, run: runEscapeScenario },
  { id: "S-6", name: "Policy Change", mandatory: false, run: runPolicyChange },
  { id: "S-7", name: "Fast Approval", mandatory: false, run: runFastApproval },
];
