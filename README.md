# Kplus122 LINE image checker

สถานะปัจจุบัน: Deploy แล้วที่ `https://kplus122-webhook.joteboony.workers.dev`

Webhook URL ที่ใช้กับ LINE:

```text
https://kplus122-webhook.joteboony.workers.dev/webhook
```

Cloudflare Worker สำหรับรับรูปจาก LINE Messaging API และตรวจเฉพาะสลิป KPLUS โดยใช้ `message.imageSet.id` ของชุดรูป 10+ ภาพจาก LINE เป็นรหัสรอบโดยตรง

1. สลิป `KPLUS`/`K+` ต้องมี `SETTLEMENT` และยอดอย่างใดอย่างหนึ่งดังนี้:

- `1.22 บาท`
- `-1.22 บาท`

เมื่อพบสลิป KPLUS ที่ถูกต้อง ระบบตอบผ่านครั้งเดียวต่อชุดรูปด้วยข้อความ `ตรวจสอบผ่าน: พบสลิป KPLUS ยอด ... บาท ข้อมูลถูกต้อง` และไม่รอสลิป KBank

คำที่ใช้เป็นหลักฐานประกอบ ได้แก่ `K+`, `KPLUS`, `THAIQR`, `Thai QR Payment` และ `QR PAYMENT` โดยไม่บังคับว่าต้องมี SALE หรือ VOID แต่ผล “ผ่าน” ต้องพบคำว่า `SETTLEMENT` และยอด `1.22` หรือ `-1.22` ด้วย

ลำดับ OCR ปัจจุบันคือ:

1. OCR.space ตรวจ 500 รูปแรกต่อวัน
2. Workers AI ตรวจเมื่อ OCR.space ครบโควตาหรือมีข้อมูลไม่พอ
3. Google Vision ตรวจยืนยันเมื่อ Workers AI ยังตัดสินไม่ได้

ระบบประมวลผลพร้อมกันสูงสุด 2 รูป โดยยังตรวจ OCR.space ทีละคำขอต่อรูป ป้องกัน Webhook/รูปเดิมซ้ำ 7 วัน และใช้ Durable Object รวมผลของแต่ละกลุ่มกับผู้ส่งอย่างปลอดภัย เพื่อไม่ให้ผลจากสองรูปเขียนทับกัน

ก่อนส่งรูป ช่างสามารถส่งข้อความที่เป็นตัวเลข 8 หลักพอดี ระบบจะเก็บเป็นเลขงานของ “กลุ่ม + ผู้ส่ง” เป็นเวลา 30 นาที และแนบเลขนี้กับ Log ของรูปถัดไป เลขงานใหม่จะแยกรอบตรวจออกจากเลขงานก่อนหน้าโดยอัตโนมัติ ระบบจะไม่เก็บข้อความ LINE อื่นที่ไม่ใช่เลข 8 หลัก

การตัดสินผ่าน/ไม่ผ่านทำด้วยกฎ deterministic จากข้อความ OCR เท่านั้น โมเดลภาพไม่มีสิทธิ์สร้างยอดเงินหรือผลตรวจเอง เพื่อป้องกัน false positive จากการเดาค่าตาม prompt

## สิ่งที่ต้องมี

- LINE Official Account และ Messaging API Channel
- Cloudflare Account ที่เปิดใช้งาน Workers AI
- OCR.space API key
- Google Cloud Vision API key สำหรับ fallback ขั้นสุดท้าย
- Node.js 20 ขึ้นไป

## 1. ติดตั้ง

```powershell
npm install
npm run check
```

## 2. ยอมรับเงื่อนไขโมเดลครั้งแรก

เข้า Cloudflare Dashboard > Workers AI > Playground เลือกโมเดล
`@cf/meta/llama-3.2-11b-vision-instruct` แล้วส่ง prompt คำว่า `agree` หนึ่งครั้ง

## 3. สร้าง Queue

ล็อกอิน Cloudflare และสร้าง Queue สำหรับงานวิเคราะห์ภาพ:

```powershell
npx wrangler login
npx wrangler queues create kplus122-images
```

## 4. ตั้ง Secret

ใช้คำสั่งแบบ interactive เท่านั้น อย่าใส่รหัสไว้ใน source code หรือ `wrangler.jsonc`:

```powershell
npx wrangler secret put LINE_CHANNEL_SECRET
npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
npx wrangler secret put CONTROL_PASSWORD
npx wrangler secret put OCR_SPACE_API_KEY
npx wrangler secret put GOOGLE_VISION_API_KEY
```

- `LINE_CHANNEL_SECRET` อยู่ใน LINE Developers > Basic settings
- `LINE_CHANNEL_ACCESS_TOKEN` ออกได้จาก LINE Developers > Messaging API
- `CONTROL_PASSWORD` ใช้เข้าสู่หน้า `/control`
- `OCR_SPACE_API_KEY` ใช้ตรวจ 500 รูปแรกของวัน

### Google Vision OCR

เปิด Cloud Vision API และ Billing ใน Google Cloud สร้าง API key ที่จำกัดการใช้งานเฉพาะ Cloud Vision API แล้วเพิ่มเป็น Secret:

```powershell
npx wrangler secret put GOOGLE_VISION_API_KEY
```

Worker ใช้ Google `DOCUMENT_TEXT_DETECTION` เป็น fallback ขั้นสุดท้ายเฉพาะรูปที่มีหลักฐานเกี่ยวกับ KPLUS ตัวนับในหน้า Control เป็นค่าประมาณของ Worker นี้ และจะหยุดเรียก Google อัตโนมัติเมื่อถึง 1,000 units ต่อเดือน

## 5. Deploy

```powershell
npm run deploy
```

เมื่อ Deploy สำเร็จจะได้ URL ลักษณะนี้ (โปรเจกต์นี้ Deploy แล้ว):

```text
https://kplus122-webhook.<ชื่อบัญชี>.workers.dev
```

ตรวจสุขภาพระบบที่:

```text
https://kplus122-webhook.<ชื่อบัญชี>.workers.dev/health
```

Webhook URL ที่ใส่ใน LINE Developers คือ:

```text
https://kplus122-webhook.<ชื่อบัญชี>.workers.dev/webhook
```

จากนั้นกด Verify, เปิด `Use webhook` และเปิด `Allow bot to join group chats`

## 6. ทดสอบ

1. เชิญ LINE Official Account เข้ากลุ่มทดลอง
2. ส่งรูปทั่วไป ระบบต้องเงียบ
3. ส่งรูปใบ KPLUS/K+ ที่เห็นยอด `1.22` หรือ `-1.22` อย่างใดอย่างหนึ่ง
4. ระบบควรตอบ `✅ ผ่าน` หรือบอกเงื่อนไขที่ขาด

## การตอบล่าช้า

ระบบประมวลผลผ่าน Queue แล้วพยายามใช้ Reply token ก่อน เพื่อประหยัดโควตาข้อความ หาก Queue ล่าช้าจน Reply token ใช้ไม่ได้ ระบบจะบันทึก error ไว้ แต่จะไม่ Push ซ้ำโดยค่าเริ่มต้น

หากต้องการให้ Push ผลกลับกลุ่มเมื่อ Reply ไม่สำเร็จ ให้เปลี่ยน `ENABLE_PUSH_FALLBACK` เป็น `true` ใน `wrangler.jsonc` แล้ว Deploy ใหม่ โปรดตรวจโควตาข้อความ LINE Official Account ก่อนเปิดใช้

## หน้า Control และสถิติ

เปิด `https://kplus122-webhook.<ชื่อบัญชี>.workers.dev/control` และเข้าสู่ระบบด้วย `CONTROL_PASSWORD` เพื่อ:

- เปิดหรือหยุดระบบตรวจรูป
- ดูจำนวน OCR.space ที่ใช้วันนี้
- ดูประมาณการ Google Vision รายเดือน
- ดูจำนวนรูปที่รับ ตรวจจบ ผ่าน ไม่ผ่าน ข้าม รูปซ้ำ และข้อผิดพลาด
- ดูจำนวนครั้งที่เรียก OCR.space, Workers AI และ Google Vision
- ดู Log ล่าสุด 50 รูป พร้อมเลขงาน 8 หลัก เส้นทาง OCR ผลตรวจ ยอดที่อ่านได้ เวลารอคิว และเวลาประมวลผล
- ล้าง Log จากหน้า Control ได้ โดย Log จะลบอัตโนมัติเมื่อเก่ากว่า 7 วัน

## การปรับเกณฑ์

แก้ค่าต่อไปนี้ใน `wrangler.jsonc` ได้โดยไม่แก้ source code:

- `EXPECTED_SALE_AMOUNT`: ยอดบวกที่ยอมรับ (ปัจจุบัน `1.22`)
- `EXPECTED_VOID_AMOUNT`: ยอดลบที่ยอมรับ (ปัจจุบัน `-1.22`)
- `MIN_CONFIDENCE`: ความมั่นใจขั้นต่ำของ AI

อย่าเก็บหรือ commit ไฟล์ `.dev.vars` เพราะมีรหัสลับ
