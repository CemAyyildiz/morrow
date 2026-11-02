import { StrictMode, type ComponentType, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "@/app/App";
import { ConfigProvider } from "@/app/ConfigProvider";
import { RouterProvider } from "@/app/router";
import { REDIRECTS } from "@/app/routes";
import "@/styles/theme.css";

type DataProvider = ComponentType<{ children: ReactNode }>;

/**
 * The dev server shows the mockup's sample data; every build reads the deployment's
 * `/config.json`. `import.meta.env.DEV` is `false` in a build, so the branch and its
 * dynamic import of the fixture are dropped (vite.config.ts fails the build otherwise).
 */
async function dataProvider(): Promise<DataProvider> {
  if (import.meta.env.DEV) {
    return (await import("@/app/SampleDataProvider")).SampleDataProvider;
  }
  return ConfigProvider;
}

const root = document.getElementById("root");
if (!root) throw new Error("index.html has no #root element");

void dataProvider().then((Provider) => {
  createRoot(root).render(
    <StrictMode>
      <Provider>
        <RouterProvider redirects={REDIRECTS}>
          <App />
        </RouterProvider>
      </Provider>
    </StrictMode>,
  );
});
