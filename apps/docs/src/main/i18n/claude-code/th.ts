import type { zh } from './zh'

export const th = {
  ccNotInstalled:
    'ไม่พบ Claude Code ในเครื่องนี้ โปรดติดตั้ง แล้วรัน `claude auth login` จากนั้นลองอีกครั้ง',
  ccUsageLimit: 'ถึงขีดจำกัดการใช้งาน Claude Code ของคุณแล้ว',
  ccUsageLimitResets: 'ถึงขีดจำกัดการใช้งาน Claude Code ของคุณแล้ว จะรีเซ็ตเวลา {time}',
  ccOverloaded: 'API ของ Claude มีภาระงานเกิน (HTTP {status}) Claude Code หยุดลองใหม่แล้ว',
  ccNotSignedIn:
    'Claude Code ยังไม่ได้ลงชื่อเข้าใช้ หรือบัญชีนี้ใช้ที่นี่ไม่ได้ โปรดรัน `claude auth login` ในเทอร์มินัล แล้วลองอีกครั้ง',
  ccBilling:
    'บัญชี Claude ของคุณมีปัญหาการเรียกเก็บเงินหรือถูกระงับ โปรดตรวจสอบที่ claude.ai แล้วลองอีกครั้ง',
  ccPromptTooLong: 'การสนทนายาวเกินกว่าที่โมเดลรองรับ โปรดเริ่มแชทใหม่แล้วลองอีกครั้ง',
  ccNetwork: 'Claude Code ไม่สามารถเชื่อมต่อเครือข่ายได้',
  ccTimeout: 'Claude Code หมดเวลารอการตอบกลับจากโมเดล',
  ccTurnLimit: 'Claude Code ถึงขีดจำกัดรอบของตัวเองสำหรับคำขอนี้แล้ว',
  ccEndedWith: 'Claude Code จบรอบนี้ด้วย "{subtype}"',
} satisfies Record<keyof typeof zh, string>
