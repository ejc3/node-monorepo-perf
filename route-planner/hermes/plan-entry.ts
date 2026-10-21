// The plan call as a Hermes program: the bundle's prelude defines PACK (the area pack's JSON
// text) and REQUEST (the plan request's); the program loads the area, times one plan call and
// prints the answer, then "plan ms N". Hermes has no file system, so the inputs come in as source.
import { call, load } from "../native/engine-lib.ts";

declare const PACK: string, REQUEST: string, print: (s: string) => void;

const h = load("area", PACK);
const t0 = Date.now();
const out = call(h, "plan", REQUEST);
const ms = Date.now() - t0;
print(out);
print(`plan ms ${ms}`);
