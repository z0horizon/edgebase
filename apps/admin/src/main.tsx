import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { initTheme } from "@/lib/theme";
import { App } from "./App";
import "./index.css";

initTheme();

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
