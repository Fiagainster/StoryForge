import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { useStore } from "./lib/store";
import "./styles.css";

// 调试与自动化测试钩子：在控制台可读写应用状态（本机桌面应用）
(window as any).__sfStore = useStore;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
