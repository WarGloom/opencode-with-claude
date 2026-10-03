import { defineConfig } from "tsup"
import { readFileSync } from "fs"

export default defineConfig({
  // tui.ts is a separate OpenCode TUI module (package export "./tui"); v1
  // rejects a single module exporting both server() and tui().
  entry: ["src/index.ts", "src/tui.ts"],
  // Provided by the OpenCode host at runtime, never bundled.
  external: ["@opentui/solid", "solid-js"],
  format: ["esm"],
  // TypeScript 7 (native/Go) no longer ships the JS Compiler API that
  // rollup-plugin-dts (used by tsup --dts) depends on. Emit .d.ts via tsc.
  dts: false,
  clean: true,
  minify: true,
  esbuildOptions(options) {
    options.supported = { ...options.supported, "template-literal": false }
  },
  esbuildPlugins: [
    {
      name: "minify-txt",
      setup(build) {
        build.onLoad({ filter: /\.txt$/ }, (args) => {
          const raw = readFileSync(args.path, "utf8")
          const minified = raw
            .split("\n")
            .map((l) => l.trimEnd())
            .join("\n")
            .replace(/\n{3,}/g, "\n")
            .trim()
          return {
            contents: `export default ${JSON.stringify(minified)}`,
            loader: "js",
          }
        })
      },
    },
  ],
})
