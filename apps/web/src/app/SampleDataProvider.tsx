import type { ReactNode } from "react";
import { sampleChallenge, sampleConfig } from "@/fixtures/mockup-sample";
import { AppDataContext, type AppData } from "./data";

// The only module that imports the mockup fixture. main.tsx loads it with a dynamic import
// under `import.meta.env.DEV`, so the dev server shows the mockup and production never
// bundles it (vite.config.ts fails the build if it does).
const SAMPLE: AppData = { config: sampleConfig, challenge: sampleChallenge };

export function SampleDataProvider({ children }: { children: ReactNode }) {
  return <AppDataContext.Provider value={SAMPLE}>{children}</AppDataContext.Provider>;
}
