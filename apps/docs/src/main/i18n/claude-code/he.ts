import type { zh } from './zh'

export const he = {
  ccNotInstalled: 'Claude Code לא נמצא במחשב זה. התקינו אותו, הריצו `claude auth login` ונסו שוב.',
  ccUsageLimit: 'הגעתם למגבלת השימוש של Claude Code.',
  ccUsageLimitResets: 'הגעתם למגבלת השימוש של Claude Code. היא תתאפס בשעה {time}.',
  ccOverloaded: 'ה-API של Claude עמוס (HTTP {status}); Claude Code הפסיק לנסות שוב.',
  ccNotSignedIn:
    'Claude Code אינו מחובר, או שחשבון זה אינו יכול להשתמש בו כאן. הריצו `claude auth login` בטרמינל ונסו שוב.',
  ccBilling: 'בחשבון Claude שלכם יש בעיית חיוב או שהוא מושהה. בדקו אותו ב-claude.ai ונסו שוב.',
  ccPromptTooLong: 'השיחה כבר אינה נכנסת למודל. התחילו צ׳אט חדש ונסו שוב.',
  ccNetwork: 'Claude Code לא הצליח להתחבר לרשת.',
  ccTimeout: 'Claude Code חרג מזמן ההמתנה למודל.',
  ccTurnLimit: 'Claude Code הגיע למגבלת התורות שלו עבור בקשה זו.',
  ccEndedWith: 'Claude Code סיים את התור עם "{subtype}".',
} satisfies Record<keyof typeof zh, string>
