import React from "react";
import ReactDOM from "react-dom/client";
import { initApiBase } from "./api/client";
import App from "./App";
import "./App.css";

initApiBase().then(() => {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
});
