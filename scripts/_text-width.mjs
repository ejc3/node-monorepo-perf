// The one text-width estimate the charts use: the chart kit (_chartstyle.mjs) lays text
// out with it (approxW, wrapPx, fitSize) and the legibility audit (_svg-audit.mjs) checks
// every text's box with it, so what a layout reserves is what the audit verifies.
//
// The charts name system-ui first, which resolves to different faces per reader: SF Pro
// on macOS, Segoe UI on Windows, Arial/Helvetica/Liberation Sans as fallbacks, and DejaVu
// Sans on many Linux desktops. DejaVu Sans is the widest of them (lowercase ~15% wider than
// Arial, bold digits ~25%), so each glyph's advance here is the wider of Arial's times
// WIDTH_MARGIN (10%, for SF Pro and Segoe UI) and DejaVu Sans' own. Tables are the fonts'
// advance widths in 1/1000 em: Arial / Arial Bold (the metrics Liberation Sans shares) and
// DejaVu Sans / DejaVu Sans Bold 2.37, rounded up. The glyphs tabled are printable ASCII
// and the symbols in MORE: every glyph the committed charts and the chart sources write.
// Any other glyph throws "unsupported glyph".

const widths = (t) => t.trim().split(/\s+/).map(Number);
// ASCII 32-126
const ARIAL = widths(`
  278 278 355 556 556 889 667 191 333 333 389 584 278 333 278 278 556 556 556 556 556
  556 556 556 556 556 278 278 584 584 584 556 1015 667 667 722 722 667 611 778 722 278
  500 667 556 833 722 778 667 778 722 667 611 722 667 944 667 667 611 278 278 278 469
  556 333 556 556 500 556 556 278 556 556 222 222 500 222 833 556 556 556 556 333 500
  278 556 500 722 500 500 500 334 260 334 584`);
const ARIAL_BOLD = widths(`
  278 333 474 556 556 889 722 238 333 333 389 584 278 333 278 278 556 556 556 556 556
  556 556 556 556 556 333 333 584 584 584 611 975 722 722 722 722 667 611 778 722 278
  556 722 611 833 722 778 667 778 722 667 611 722 667 944 667 667 611 333 278 333 584
  556 333 556 611 556 611 556 333 611 611 278 278 556 278 889 611 611 611 611 389 556
  333 611 556 778 556 556 500 389 280 389 584`);
const DEJAVU = widths(`
  318 401 460 838 637 951 780 275 391 391 500 838 318 361 318 337 637 637 637 637 637
  637 637 637 637 637 337 337 838 838 838 531 1000 685 687 699 771 632 576 775 752 295
  295 656 558 863 749 788 604 788 695 635 611 732 685 989 686 611 686 391 337 391 838
  500 500 613 635 550 635 616 353 635 634 278 278 580 278 975 634 612 635 635 412 521
  393 634 592 818 592 592 525 637 337 637 838`);
const DEJAVU_BOLD = widths(`
  349 457 521 838 696 1002 873 307 458 458 523 838 380 416 380 366 696 696 696 696 696
  696 696 696 696 696 400 400 838 838 838 581 1000 774 763 734 831 684 684 821 837 373
  373 775 638 996 837 851 733 851 771 721 683 813 774 1104 771 725 726 458 366 458 838
  500 500 675 716 593 716 679 436 716 712 343 343 666 343 1042 712 688 716 716 494 596
  479 712 652 924 646 652 583 712 366 712 838`);
// punctuation and symbols the charts use outside ASCII:
// [Arial, Arial Bold, DejaVu Sans, DejaVu Sans Bold]
const MORE = {
  " ": [278, 278, 318, 349],
  "·": [333, 333, 318, 380],
  "×": [584, 584, 838, 838],
  "–": [556, 556, 500, 500],
  "—": [1000, 1000, 1000, 1000],
  "−": [584, 584, 838, 838],
  "±": [549, 549, 838, 838],
  "≥": [549, 549, 838, 838],
  "≤": [549, 549, 838, 838],
  "…": [1000, 1000, 1000, 1000],
  "→": [1000, 1000, 838, 838],
  "←": [1000, 1000, 838, 838],
  "°": [400, 400, 500, 500],
  µ: [576, 576, 637, 736],
  "•": [350, 350, 590, 640],
  "‘": [222, 278, 318, 380],
  "’": [222, 278, 318, 380],
  "“": [333, 500, 519, 658],
  "”": [333, 500, 519, 658],
  "÷": [549, 549, 838, 838],
  "≈": [549, 549, 838, 838],
};
// how far ASCII glyphs reach below the baseline, as a share of the font size; the rest
// reach 0.03 below it (round overshoot)
const DESCENDERS = { g: 0.21, j: 0.21, p: 0.21, q: 0.21, y: 0.21, Q: 0.06, $: 0.08 };
for (const ch of ",;_") DESCENDERS[ch] = 0.15;
for (const ch of "()[]{}|@") DESCENDERS[ch] = 0.21;

// Arial's widening for the system-ui faces near its metrics (SF Pro, Segoe UI)
export const WIDTH_MARGIN = 1.1;
export const isBold = (weight) => /^(bold|bolder)$/i.test(String(weight)) || +weight >= 600;

// one glyph's advance in em: the wider of Arial x WIDTH_MARGIN and DejaVu Sans. A
// character the tables do not hold throws: a guessed width can understate the real face
// (œ is 1.02 em in DejaVu Sans), so a chart that writes a new glyph fails until it is
// tabled here from both fonts.
const advance = (ch, bold) => {
  const c = ch.codePointAt(0);
  if (c >= 32 && c <= 126) {
    const i = c - 32;
    return Math.max(
      ((bold ? ARIAL_BOLD : ARIAL)[i] * WIDTH_MARGIN) / 1000,
      (bold ? DEJAVU_BOLD : DEJAVU)[i] / 1000,
    );
  }
  const m = MORE[ch];
  if (m) return Math.max((m[bold ? 1 : 0] * WIDTH_MARGIN) / 1000, m[bold ? 3 : 2] / 1000);
  throw new Error(
    `unsupported glyph "${ch}" (U+${c.toString(16).toUpperCase().padStart(4, "0")}): no advance width is tabled for it in _text-width.mjs`,
  );
};

// a text's glyph cells relative to its start, in px: per character its advance and its
// reach above (0.75 em) and below the baseline. Every character must be tabled (a
// combining mark, a control character or any other glyph throws).
export const glyphCells = (s, px, weight = "") => {
  const bold = isBold(weight);
  const cells = [];
  let x = 0;
  for (const ch of String(s)) {
    const up = 0.75 * px;
    const down = (DESCENDERS[ch] ?? 0.03) * px;
    const adv = advance(ch, bold) * px;
    cells.push({ x0: x, x1: x + adv, up, down, ink: /\S/u.test(ch) });
    x += adv;
  }
  return { width: x, cells };
};

// the estimated advance width (px) of `s` at `px` in `weight` ("600" or more, or "bold",
// is bold)
export const textWidth = (s, px, weight = "") => glyphCells(s, px, weight).width;
