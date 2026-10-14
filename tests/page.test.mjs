import { test } from "node:test";
import { readFileSync } from "node:fs";
import { Script, runInNewContext } from "node:vm";

test("monitor page inline JavaScript parses", () => {
  const source = readFileSync(new URL("../src/page.ts", import.meta.url), "utf8");
  const page = runInNewContext(source.replace("export const page =", "const page =") + "\npage;");
  const script = page.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  if (!script) throw new Error("Monitor page script missing");
  new Script(script);
});
