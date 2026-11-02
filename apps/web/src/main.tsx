import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "@/app/App";
import { RouterProvider } from "@/app/router";
import { REDIRECTS } from "@/app/routes";
import { SampleDataProvider } from "@/app/SampleDataProvider";
import "@/styles/theme.css";

const root = document.getElementById("root");
if (!root) throw new Error("index.html has no #root element");

createRoot(root).render(
  <StrictMode>
    <SampleDataProvider>
      <RouterProvider redirects={REDIRECTS}>
        <App />
      </RouterProvider>
    </SampleDataProvider>
  </StrictMode>,
);
