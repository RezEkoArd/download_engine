import React from "react";
import ReactDOM from "react-dom/client";
import Island from "./Island";
import "./App.css";

// Named `island-entry` rather than `island`: Windows filesystems are
// case-insensitive, so `island.tsx` and `Island.tsx` are one file, and the
// entry point silently overwrote the component.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Island />
  </React.StrictMode>,
);
