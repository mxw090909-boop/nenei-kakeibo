import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const appHotfixPlugin = () => ({
  name: "nenei-app-hotfix",
  enforce: "pre",
  transform(code, id) {
    if (!id.endsWith("/src/App.jsx") && !id.endsWith("\\src\\App.jsx")) return null;
    const patched = code
      .replaceAll("<CatSelect", "<CatPicker")
      .replaceAll("</CatSelect>", "</CatPicker>");
    return patched === code ? null : { code: patched, map: null };
  },
});

export default defineConfig({
  plugins: [appHotfixPlugin(), react()],
  base: "./",
});
