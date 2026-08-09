import { describe, expect, it } from "vitest";
import {
  acceptWorkerPaymentName,
  VISIBLE_TEXT_PROMPT,
  decideReceipt,
  formatDecision,
  formatKplusSuccess,
  hasExpectedAmount,
  hasGoogleCandidateTextEvidence,
  hasSettlementText,
  hasThaiQrPaymentText,
  hasWrongAmountConsensus,
  inspectConfirmedReceiptText,
  inspectReceiptText,
  isConfirmedKplusReceiptText,
  isKplusCandidateText,
  parseKplusVisualCandidate,
  routeOcrSpaceDecision,
  routePaddleOcrDecision,
  shouldContinueToGoogleVision,
  shouldReplyAfterGoogleVision,
} from "../src/analyze";

describe("receipt decision", () => {
  it("keeps target values out of the AI prompt", () => {
    expect(VISIBLE_TEXT_PROMPT).not.toMatch(/KPLUS|1[.]22|VOID|SETTLEMENT/i);
  });

  it("ignores an equipment label that only says KBank", () => {
    const equipmentText = "KBank Cash\nTID 28254061\nK-BIZ Contact Center";
    expect(isKplusCandidateText(equipmentText)).toBe(false);
  });

  it("does not confuse the bot name Kplus122 with a KPLUS receipt", () => {
    expect(isKplusCandidateText("Kplus122 replied at 17:50\n1.22")).toBe(false);
  });

  it("parses the targeted visual classifier without accepting a negative", () => {
    expect(parseKplusVisualCandidate("CANDIDATE")).toBe(true);
    expect(parseKplusVisualCandidate("NOT_CANDIDATE")).toBe(false);
    expect(parseKplusVisualCandidate("This is not candidate.")).toBe(false);
  });

  it("does not send arbitrary decimal numbers to Google without receipt evidence", () => {
    const inspection = inspectReceiptText("34.73 50.00 8.88");

    expect(inspection.observedAmounts).toEqual([34.73, 50, 8.88]);
    expect(hasGoogleCandidateTextEvidence(inspection, 1.22, -1.22)).toBe(false);
  });

  it("keeps an expected amount as partial Google evidence", () => {
    const inspection = inspectReceiptText("AMOUNT 1.22");

    expect(hasGoogleCandidateTextEvidence(inspection, 1.22, -1.22)).toBe(true);
  });

  it.each([
    "THAIQR",
    "Thai QR Payment",
    "THAIQR PAYMENT",
    "ThaiQRPayment",
    "QR PAYMENT",
    "QRPayment",
  ])("uses %s as partial Google evidence", (text) => {
    const inspection = inspectReceiptText(text);

    expect(hasThaiQrPaymentText(text)).toBe(true);
    expect(hasGoogleCandidateTextEvidence(inspection, 1.22, -1.22, text)).toBe(true);
  });

  it("does not treat an unrelated QR label as Thai QR Payment", () => {
    expect(hasThaiQrPaymentText("QR CODE FOR SERVICE FORM")).toBe(false);
  });

  it.each([
    "THAIQR",
    "Thai QR Payment",
    "QR PAYMENT",
  ])("passes directly from Workers AI when %s and the expected amount are readable", (name) => {
    const sourceText = `${name}\nSETTLEMENT\nAMOUNT 1.22`;
    const inspection = inspectReceiptText(sourceText);
    const accepted = acceptWorkerPaymentName(inspection, sourceText);

    expect(decideReceipt(accepted, 1.22, -1.22, 0.65).status).toBe("pass");
  });

  it("does not direct-pass a payment name without the expected amount", () => {
    const text = "Thai QR Payment\nSETTLEMENT\nAMOUNT 8.00";
    const accepted = acceptWorkerPaymentName(inspectReceiptText(text), text);

    expect(decideReceipt(accepted, 1.22, -1.22, 0.65).status).toBe("fail");
  });

  it.each([
    "SALES THB 0.00\nTOTAL THB 0.00",
    "AMT: THB 5.00",
    "AMT: THB unreadable",
  ])("sends OCR.space results without the expected amount to fallback: %s", (amountText) => {
    const inspection = inspectConfirmedReceiptText(
      `CHANNEL: KPLUS\nTHAI QR PAYMENT\nSETTLEMENT\n${amountText}`,
    );
    const decision = decideReceipt(inspection, 1.22, -1.22, 0.65);

    expect(routeOcrSpaceDecision(decision, inspection)).toBe("fallback");
  });

  it.each(["1.22", "-1.22"])(
    "finishes at OCR.space when the expected amount %s is found",
    (amount) => {
      const inspection = inspectConfirmedReceiptText(
        `CHANNEL: KPLUS\nSETTLEMENT\nAMT: THB ${amount}`,
      );
      const decision = decideReceipt(inspection, 1.22, -1.22, 0.65);

      expect(routeOcrSpaceDecision(decision, inspection)).toBe("pass");
    },
  );

  it.each([
    "CHANNEL: KPLUS\nTHAI QR PAYMENT\nAMT: THB 5.00",
    "THAI QR PAYMENT\nAMT: THB 5.00",
  ])("continues detailed inspection when OCR.space finds KPLUS without SETTLEMENT: %s", (text) => {
    const inspection = acceptWorkerPaymentName(
      inspectConfirmedReceiptText(text),
      text,
    );
    const decision = decideReceipt(inspection, 1.22, -1.22, 0.65);

    expect(routeOcrSpaceDecision(decision, inspection)).toBe("fallback");
  });

  it("keeps known KPLUS evidence sticky when OCR.space misses it", () => {
    const inspection = inspectConfirmedReceiptText(
      "OTHER RECEIPT\nAMT: THB 5.00",
    );
    const decision = decideReceipt(inspection, 1.22, -1.22, 0.65);

    expect(routeOcrSpaceDecision(decision, inspection, true)).toBe("fallback");
  });

  it("still ignores OCR.space evidence when no provider finds KPLUS", () => {
    const inspection = inspectConfirmedReceiptText(
      "SETTLEMENT\nAMT: THB 5.00",
    );
    const decision = decideReceipt(inspection, 1.22, -1.22, 0.65);

    expect(routeOcrSpaceDecision(decision, inspection)).toBe("ignore");
  });

  it("continues from Workers AI to Google when an earlier provider found KPLUS", () => {
    expect(shouldContinueToGoogleVision(true, false, false)).toBe(true);
  });

  it("stops before Google when no provider or classifier finds useful evidence", () => {
    expect(shouldContinueToGoogleVision(false, false, false)).toBe(false);
  });

  it.each([
    {
      name: "KPLUS only with a wrong amount",
      text: "CHANNEL: KPLUS\nAMT: THB 5.00",
    },
    {
      name: "KPLUS only with the expected amount",
      text: "CHANNEL: KPLUS\nAMT: THB 1.22",
    },
    {
      name: "KPLUS only with no readable amount",
      text: "CHANNEL: KPLUS\nAMT: THB unreadable",
    },
    {
      name: "SETTLEMENT only with a wrong amount",
      text: "SETTLEMENT\nAMT: THB 5.00",
    },
    {
      name: "SETTLEMENT only with the expected amount",
      text: "SETTLEMENT\nAMT: THB 1.22",
    },
    {
      name: "SETTLEMENT only with no readable amount",
      text: "SETTLEMENT\nAMT: THB unreadable",
    },
    {
      name: "the expected amount only",
      text: "AMT: THB 1.22",
    },
    {
      name: "the expected void amount only",
      text: "AMT: THB -1.22",
    },
    {
      name: "KPLUS and SETTLEMENT with a wrong amount",
      text: "CHANNEL: KPLUS\nSETTLEMENT\nAMT: THB 5.00",
    },
  ])("sends PaddleOCR $name to OCR.space", ({ text }) => {
    const inspection = inspectConfirmedReceiptText(text);
    const decision = decideReceipt(inspection, 1.22, -1.22, 0.65);

    expect(routePaddleOcrDecision(decision, inspection, 1.22, -1.22)).toBe(
      "fallback",
    );
  });

  it("keeps PaddleOCR silent when it finds no KPLUS, SETTLEMENT, or expected amount", () => {
    const inspection = inspectConfirmedReceiptText(
      "OTHER RECEIPT\nAMT: THB 5.00",
    );
    const decision = decideReceipt(inspection, 1.22, -1.22, 0.65);

    expect(routePaddleOcrDecision(decision, inspection, 1.22, -1.22)).toBe(
      "ignore",
    );
  });

  it.each(["1.22", "-1.22"])(
    "passes directly from PaddleOCR when all evidence and amount %s are present",
    (amount) => {
      const inspection = inspectConfirmedReceiptText(
        `CHANNEL: KPLUS\nSETTLEMENT\nAMT: THB ${amount}`,
      );
      const decision = decideReceipt(inspection, 1.22, -1.22, 0.65);

      expect(routePaddleOcrDecision(decision, inspection, 1.22, -1.22)).toBe(
        "pass",
      );
    },
  );

  it("stops after PaddleOCR and OCR.space agree on the same wrong amount", () => {
    const paddle = inspectConfirmedReceiptText(
      "CHANNEL: KPLUS\nSETTLEMENT\nAMT: THB 5.00",
    );
    const ocrSpace = inspectConfirmedReceiptText(
      "CHANNEL: KPLUS\nSETTLEMENT\nAMOUNT: 5.00 THB",
    );

    expect(hasWrongAmountConsensus(paddle, ocrSpace, 1.22, -1.22)).toBe(true);
  });

  it("accepts the normal OCR amount tolerance for wrong-amount consensus", () => {
    const paddle = inspectConfirmedReceiptText(
      "CHANNEL: KPLUS\nSETTLEMENT\nAMT: THB 5.00",
    );
    const ocrSpace = {
      ...paddle,
      observedAmounts: [5.004],
      labeledAmounts: [5.004],
    };

    expect(hasWrongAmountConsensus(paddle, ocrSpace, 1.22, -1.22)).toBe(true);
  });

  it.each([
    {
      name: "one provider cannot read an amount",
      paddle: "CHANNEL: KPLUS\nSETTLEMENT\nAMT: THB unreadable",
      ocrSpace: "CHANNEL: KPLUS\nSETTLEMENT\nAMT: THB 5.00",
    },
    {
      name: "the providers read different amounts",
      paddle: "CHANNEL: KPLUS\nSETTLEMENT\nAMT: THB 5.00",
      ocrSpace: "CHANNEL: KPLUS\nSETTLEMENT\nAMT: THB 8.00",
    },
    {
      name: "only one amount overlaps",
      paddle: "CHANNEL: KPLUS\nSETTLEMENT\nTHB 0.00\nTHB 5.00",
      ocrSpace: "CHANNEL: KPLUS\nSETTLEMENT\nTHB 0.00\nTHB 8.00",
    },
    {
      name: "KPLUS is missing",
      paddle: "SETTLEMENT\nAMT: THB 5.00",
      ocrSpace: "CHANNEL: KPLUS\nSETTLEMENT\nAMT: THB 5.00",
    },
    {
      name: "SETTLEMENT is missing",
      paddle: "CHANNEL: KPLUS\nAMT: THB 5.00",
      ocrSpace: "CHANNEL: KPLUS\nSETTLEMENT\nAMT: THB 5.00",
    },
    {
      name: "one provider finds the expected amount",
      paddle: "CHANNEL: KPLUS\nSETTLEMENT\nAMT: THB 5.00",
      ocrSpace: "CHANNEL: KPLUS\nSETTLEMENT\nAMT: THB 1.22",
    },
  ])("continues fallback when $name", ({ paddle, ocrSpace }) => {
    expect(hasWrongAmountConsensus(
      inspectConfirmedReceiptText(paddle),
      inspectConfirmedReceiptText(ocrSpace),
      1.22,
      -1.22,
    )).toBe(false);
  });

  it("does not use generic receipt structure as Google evidence", () => {
    const inspection = inspectReceiptText(
      "KBank CREDIT CARD\nSALE\nVOID\nTHB 80.00\nSETTLEMENT",
    );

    expect(hasGoogleCandidateTextEvidence(inspection, 1.22, -1.22)).toBe(false);
  });

  it("formats the requested KPLUS-only success message", () => {
    expect(formatKplusSuccess(1.22)).toBe(
      "✅ ตรวจสอบผ่าน: พบสลิป KPLUS ยอด 1.22 บาท ข้อมูลถูกต้อง",
    );
    expect(formatKplusSuccess(-1.22)).toBe(
      "✅ ตรวจสอบผ่าน: พบสลิป KPLUS ยอด -1.22 บาท ข้อมูลถูกต้อง",
    );
  });

  it("does not confirm KPLUS when it only appears in a service-form table", () => {
    const text = [
      "CASTLES TECHNOLOGY",
      "JOB TYPE: SERVICE",
      "ACQUIRER TERMINAL ID MERCHANT ID FUNCTION",
      "KBANK 62314012 401015477563001",
      "KPLUS 62314012 401015477563001",
      "APPLICATION: CA_321_GENERIC 1.28 8444",
    ].join("\n");

    expect(isConfirmedKplusReceiptText(text)).toBe(false);
    expect(inspectConfirmedReceiptText(text).isKplusReceipt).toBe(false);
  });

  it("confirms KPLUS only in KPLUS payment context", () => {
    expect(isConfirmedKplusReceiptText("CHANNEL: KPLUS\nAMT: THB 1.22")).toBe(true);
    expect(isConfirmedKplusReceiptText("CARD NAME: KPLUS\nAMOUNT: -1.22 THB")).toBe(true);
  });

  it.each([
    "THAIQR",
    "Thai QR Payment",
    "THAIQR PAYMENT",
    "ThaiQRPayment",
    "QR PAYMENT",
    "QRPayment",
  ])("uses %s in Google KPLUS confirmation", (keyword) => {
    expect(isConfirmedKplusReceiptText(`KPLUS\n${keyword}\nAMOUNT 1.22`)).toBe(true);
  });

  it("passes KPLUS with a positive 1.22 amount", () => {
    const inspection = inspectReceiptText("CHANNEL: KPLUS\nSETTLEMENT\nAMT: THB 1.22");
    const decision = decideReceipt(inspection, 1.22, -1.22, 0.65);

    expect(inspection).toMatchObject({
      isKplusReceipt: true,
      hasSettlement: true,
      observedAmounts: [1.22],
    });
    expect(decision).toEqual({ status: "pass", failures: [] });
    expect(hasExpectedAmount(inspection, 1.22, -1.22)).toBe(true);
    expect(formatDecision(inspection, decision)).toContain("1.22");
  });

  it("passes K+ with a negative -1.22 amount", () => {
    const inspection = inspectReceiptText("K+\nSETTLEMENT\nVOID\nAMT: -THB 1.22");
    const decision = decideReceipt(inspection, 1.22, -1.22, 0.65);

    expect(inspection).toMatchObject({
      isKplusReceipt: true,
      hasSettlement: true,
      observedAmounts: [-1.22],
    });
    expect(decision).toEqual({ status: "pass", failures: [] });
    expect(formatDecision(inspection, decision)).toContain("-1.22");
  });

  it.each([
    "AMT: THB 1.22",
    "AMT : THB -1.22",
    "AMT: 1.22 THB",
    "AMOUNT: 1.22 THB",
    "AMOUNT THB 1.22",
    "AMT:\nTHB\n-1.22",
    "AMOUNT: THB 1,22",
  ])("accepts the expected amount from the labeled field: %s", (amountText) => {
    const inspection = inspectReceiptText(`CHANNEL: KPLUS\nSETTLEMENT\n${amountText}`);

    expect(inspection.labeledAmounts).toSatisfy(
      (amounts: number[]) => amounts.some((amount) => Math.abs(Math.abs(amount) - 1.22) < 0.005),
    );
    expect(decideReceipt(inspection, 1.22, -1.22, 0.65).status).toBe("pass");
  });

  it("accepts an expected amount anywhere even when the labeled amount is different", () => {
    const inspection = inspectReceiptText(
      "CHANNEL: KPLUS\nSETTLEMENT\nAMT: THB 80.00\nFEE: THB 1.22",
    );

    expect(inspection.observedAmounts).toEqual([80, 1.22]);
    expect(inspection.labeledAmounts).toEqual([80]);
    expect(decideReceipt(inspection, 1.22, -1.22, 0.65).status).toBe("pass");
  });

  it("accepts an unlabeled expected amount anywhere on the receipt", () => {
    const inspection = inspectReceiptText("CHANNEL: KPLUS\nSETTLEMENT\nFEE: THB 1.22");

    expect(inspection.observedAmounts).toEqual([1.22]);
    expect(inspection.labeledAmounts).toEqual([]);
    expect(decideReceipt(inspection, 1.22, -1.22, 0.65).status).toBe("pass");
  });

  it("accepts 1.22 from the settlement summary without AMT/AMOUNT", () => {
    const inspection = inspectReceiptText([
      "KPLUS",
      "SETTLEMENT",
      "SALES THB 0.00",
      "VOID 1 -THB 1.22",
      "TOTAL THB 0.00",
      "SETTLEMENT SUCCESSFUL",
    ].join("\n"));

    expect(inspection.labeledAmounts).toEqual([]);
    expect(inspection.observedAmounts).toContain(-1.22);
    expect(decideReceipt(inspection, 1.22, -1.22, 0.65).status).toBe("pass");
  });

  it("fails KPLUS when the amount is not 1.22 or -1.22", () => {
    const inspection = inspectReceiptText("KPLUS\nSETTLEMENT\nAMT: THB 2.22");
    const decision = decideReceipt(inspection, 1.22, -1.22, 0.65);

    expect(decision.status).toBe("fail");
    expect(formatDecision(inspection, decision)).toBe([
      "❌ ตรวจสอบไม่ผ่าน: สลิป KPLUS",
      "ยอดที่อ่านได้: 2.22 บาท",
      "สาเหตุ: ไม่พบยอด 1.22 หรือ -1.22 บาท",
      "หาก Test ผ่าน Link POS อย่าลืมลง Remark",
    ].join("\n"));
  });

  it("fails KPLUS when no amount can be read", () => {
    const inspection = inspectReceiptText("KPLUS\nSETTLEMENT\nAMT: THB unreadable");
    const decision = decideReceipt(inspection, 1.22, -1.22, 0.65);

    expect(decision.status).toBe("fail");
    expect(formatDecision(inspection, decision)).not.toContain("Link POS");
  });

  it("replies with a failure when Google confirms KPLUS with another amount", () => {
    const inspection = inspectConfirmedReceiptText("CHANNEL: KPLUS\nSETTLEMENT\nAMT: THB 5.00");

    expect(shouldReplyAfterGoogleVision(inspection)).toBe(true);
    expect(decideReceipt(inspection, 1.22, -1.22, 0.65).status).toBe("fail");
  });

  it("stays silent when Google does not confirm KPLUS", () => {
    const inspection = inspectConfirmedReceiptText("OTHER RECEIPT\nAMT: THB 1.22");

    expect(shouldReplyAfterGoogleVision(inspection)).toBe(false);
  });

  it("stays silent when KPLUS is visible without SETTLEMENT", () => {
    const inspection = inspectConfirmedReceiptText(
      "CHANNEL: KPLUS\nSALE Thai QR Payment\nAMT: THB 540.00",
    );

    expect(inspection.isKplusReceipt).toBe(true);
    expect(inspection.hasSettlement).toBe(false);
    expect(shouldReplyAfterGoogleVision(inspection)).toBe(false);
  });

  it("fails when SETTLEMENT is missing even if KPLUS and 1.22 are readable", () => {
    const inspection = inspectReceiptText("CHANNEL: KPLUS\nAMT: THB 1.22");
    const decision = decideReceipt(inspection, 1.22, -1.22, 0.65);

    expect(hasSettlementText("settlement successful")).toBe(true);
    expect(inspection.hasSettlement).toBe(false);
    expect(decision.status).toBe("fail");
    expect(decision.failures).toContain("ไม่พบคำว่า SETTLEMENT");
  });
});
