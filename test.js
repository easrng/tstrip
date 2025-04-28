import { codeFrameColumns } from "@babel/code-frame";
import { Parser } from "acorn";
import { readFile, writeFile } from "fs/promises";
import { stripTypes as tsStripTypes } from "./strip.js";
let jsStripTypes
const src = await readFile("strip.ts", "utf-8");
const s1 = await test(src, tsStripTypes);
await writeFile("strip.js", s1, "utf-8");
jsStripTypes = (await import("./strip.js?1")).stripTypes;
await test(src, jsStripTypes);
async function test(code, f) {
  const js = f(code);
  try {
    Parser.parse(js, {
      sourceType: "module",
      ecmaVersion: "latest",
    });
    if (f === jsStripTypes) {
      console.log(
        codeFrameColumns(
          js,
          {},
          {
            highlightCode: true,
          }
        )
      );
    }
    return js;
  } catch (e) {
    console.log(
      codeFrameColumns(
        js,
        {},
        {
          highlightCode: true,
        }
      )
    );
    throw e;
  }
}
