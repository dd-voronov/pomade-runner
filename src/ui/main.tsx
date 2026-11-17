// Runner's UI: one bundle for every surface Pomade opens it on — the side panel and the tab — and
// for a plain browser, where it says that it has no host.

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { connect } from "pomade-kit/sdk";

import { App } from "./App";
import "./tokens.css";

const root = document.getElementById("root");
if (!root) throw new Error("Runner: index.html has no #root");

const connection = await connect();
if (connection.status === "connected") document.documentElement.dataset.surface = connection.host.welcome.surface;

createRoot(root).render(
  <StrictMode>
    <App connection={connection} />
  </StrictMode>,
);
