// Self-host build wrapper: same config, minus the type checker and sourcemaps (low-RAM server).
import baseConfig from "./vite.config.mts";

export default (env) => {
  const config = baseConfig(env);
  return {
    ...config,
    plugins: config.plugins.flat().filter((p) => p && p.name !== "vite-plugin-checker"),
    build: { ...config.build, sourcemap: false },
  };
};
