import "./otel";
import '@fortawesome/fontawesome-free/css/all.min.css';
import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";

const root = createRoot(document.getElementById("root")!);
root.render(<App />);