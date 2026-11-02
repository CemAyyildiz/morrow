import type { ReactNode } from "react";
import { sampleChallenge, sampleConfig } from "@/fixtures/mockup-sample";
import { AppDataContext, type AppData } from "./data";

// The only module that imports the mockup fixture. Story 1.9b replaces it with a provider
// that reads /config.json; the sample data must be gone before any public deploy.
const SAMPLE: AppData = { config: sampleConfig, challenge: sampleChallenge };

export function SampleDataProvider({ children }: { children: ReactNode }) {
  return <AppDataContext.Provider value={SAMPLE}>{children}</AppDataContext.Provider>;
}
