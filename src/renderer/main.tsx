import { createRoot } from "react-dom/client";
import { App } from "./App";
import { engine } from "./engine";
import "./styles.css";

engine.start();
createRoot(document.getElementById("root")!).render(<App />);
