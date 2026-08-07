import React from "react";
import { createRoot } from "react-dom/client";
import "./i18n";
import { App } from "./App";
import "./styles.css";

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { hasError: boolean; error: Error | null }> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("React Error Boundary caught an error:", error, errorInfo);
    try {
      if (window.lokameet?.log?.write) {
        void window.lokameet.log.write({ 
          level: "ERROR", 
          scope: "renderer/error-boundary", 
          msg: "React component error", 
          data: { error: String(error), stack: error.stack, componentStack: errorInfo.componentStack } 
        });
      }
    } catch {
      // Сбой вторичного логирования не должен скрывать страницу восстановления после основной ошибки.
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 20, fontFamily: "system-ui" }}>
          <h2>Произошла ошибка</h2>
          <p>{this.state.error?.message || "Неизвестная ошибка"}</p>
          <button onClick={() => window.location.reload()}>Перезагрузить приложение</button>
        </div>
      );
    }

    return this.props.children;
  }
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);

