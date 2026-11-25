// Runner's UI: one bundle for every surface Pomade opens it on — the side panel and the tab — and
// for a plain browser, where it says that it has no host.

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { connect, postMessageTransport } from "pomade-kit/sdk";

import { App } from "./App";
import { ToastProvider, TooltipLayer } from "./kit";
import { PlatformCalls, transportCaller } from "./platformCalls";
import "./tokens.css";
import "./base.css";

const root = document.getElementById("root");
if (!root) throw new Error("Runner: index.html has no #root");

// The kit's default transport, kept: the calls its client has no method for yet go over it too.
const transport = postMessageTransport(window);
const connection = await connect({ transport });
if (connection.status === "connected") document.documentElement.dataset.surface = connection.host.welcome.surface;

createRoot(root).render(
  <StrictMode>
    <ToastProvider>
      <PlatformCalls.Provider value={connection.status === "connected" ? transportCaller(transport) : null}>
        <App connection={connection} />
      </PlatformCalls.Provider>
      <TooltipLayer />
    </ToastProvider>
  </StrictMode>,
);
