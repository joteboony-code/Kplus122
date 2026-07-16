import { describe, expect, it } from "vitest";
import { decideReceipt } from "../src/analyze";

const evaluatedReceipts = [
  ["129346.jpg", "pass", [1.22, 0, -1.22, 0.08]],
  ["S__78110732.jpg", "pass", [1.22, 0, -1.22, 8.08]],
  ["465548.jpg", "pass", [1.22, 8.88, -1.22, 0.88]],
  ["S__25845774.jpg", "pass", [1.22, 0, -1.22]],
  ["S__78168088.jpg", "pass", [1.22, 0, -1.22]],
  ["465673.jpg", "pass", [1.22, -1.22, 0, 8.88]],
  ["129833.jpg", "fail", [100, 0, -100]],
  ["S__78356487.jpg", "pass", [0, -1.22, 8, 1.22]],
  ["S__25911307.jpg", "pass", [1.22, 8.88, -1.22]],
  ["129912.jpg", "pass", [1.22, -1.22, 0, 8]],
  ["129921.jpg", "pass", [1.22, -1.22, 0]],
  ["S__78372887.jpg", "pass", [-1.22, 8.88, 1.22]],
  ["S__78372898.jpg", "pass", [16.36, -1.24, 8.88, 1.22, -1.22]],
  ["319121.jpg", "pass", [1.22, -1.22, 0]],
  ["319132.jpg", "pass", [1.22, -1.22, 0]],
  ["S__25927697.jpg", "fail", [5, -5, 0]],
  ["130002.jpg", "pass", [-1.22, 1.86, 81.89, 1.22, 8.88]],
  ["130048.jpg", "pass", [1.22, -1.22, 0]],
  ["466138.jpg", "pass", [1.22, 8.08, -1.22, 8.88, 0]],
  ["466355.jpg", "pass", [1.22, -1.22, 8.88]],
  ["11848.jpg", "fail", [1, -1, 8.08, -1.88, 8.88]],
  ["S__26034187.jpg", "pass", [-1.22, 1.22, 0]],
  ["S__26042381.jpg", "pass", [1.22, 0, -1.22]],
  ["130532.jpg", "pass", [1.22, -1.22, 0]],
  ["319550.jpg", "fail", [80, 0, -80]],
  ["S__32948232.jpg", "pass", [0, 1.22, -1.22]],
  ["S__32964618.jpg", "pass", [1.22, -1.22, 0, 8.08]],
  ["8001.jpg", "fail", [1, -1, 0.08, -1.88, 8.88, 8]],
  ["8047.jpg", "pass", [1.22, 0, 8.88, -1.22]],
  ["8128.jpg", "fail", [80, 0, -88.88, 8.88]],
  ["S__78929935.jpg", "pass", [1.22, -1.22, 0]],
  ["S__78962704.jpg", "pass", [1.22, 1.18, 81.89, 8.08, -1.22, 0, 8.88]],
  ["12824.jpg", "pass", [1.22, -1.22, 0, 8.08, 8.88]],
] as const;

describe("33-image labeled receipt dataset", () => {
  it.each(evaluatedReceipts)("keeps %s classified as %s", (_name, expected, amounts) => {
    const decision = decideReceipt({
      isKplusReceipt: true,
      hasSettlement: true,
      observedAmounts: [...amounts],
      labeledAmounts: [...amounts],
      confidence: 0.99,
      reason: "Google Vision evaluation fixture",
    }, 1.22, -1.22, 0.65);

    expect(decision.status).toBe(expected);
  });
});
