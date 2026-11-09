// Builds the connector's headless pages (whiteboard-sync/render/) into
// excalidraw-app/build/render/: render.html (renders a board or frame) and
// ops.html (builds Claude's edits with Excalidraw's own element code).
// Reuses the app's aliases and plugins, minus the ones that only make sense
// for the editor (PWA, sitemap, type checker, HTML minifier).
//
//   cd excalidraw-app && npx vite build --config ../whiteboard-sync/vite.render.config.mts
import path from "path";

import baseConfig from "../excalidraw-app/vite.config.mts";

const EDITOR_ONLY_PLUGINS = /checker|pwa|sitemap|html|excalidraw-lazy-chunks/i;

export default (env) => {
  const config = baseConfig(env);
  return {
    ...config,
    root: path.resolve(__dirname, "render"),
    envDir: path.resolve(__dirname, ".."),
    base: "/render/",
    publicDir: false,
    plugins: config.plugins
      .flat(Infinity)
      .filter((p) => p && !EDITOR_ONLY_PLUGINS.test(p.name)),
    build: {
      ...config.build,
      outDir: path.resolve(__dirname, "../excalidraw-app/build/render"),
      emptyOutDir: true,
      sourcemap: false,
      rollupOptions: {
        ...config.build.rollupOptions,
        input: {
          render: path.resolve(__dirname, "render/render.html"),
          ops: path.resolve(__dirname, "render/ops.html"),
        },
      },
    },
  };
};
