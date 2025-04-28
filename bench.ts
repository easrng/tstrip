import { ScriptTarget, transpileModule } from "typescript";
import { stripTypes } from "./strip.js";

const input = await (await fetch(
    "https://raw.githubusercontent.com/microsoft/TypeScript/refs/heads/main/src/compiler/checker.ts",
)).text();
Deno.bench("me", () => {
    stripTypes(input);
});
Deno.bench("typescript", () => {
    transpileModule(input, {
        moduleName: "checker.ts",
        compilerOptions: {
            target: ScriptTarget.ESNext,
        },
    });
});
