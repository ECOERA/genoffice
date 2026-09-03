import type { zh } from './zh'

export const ar = {
  ccNotInstalled:
    'لم يتم العثور على Claude Code على هذا الجهاز. ثبّته ثم شغّل `claude auth login` وحاول مرة أخرى.',
  ccUsageLimit: 'لقد بلغت حد استخدام Claude Code.',
  ccUsageLimitResets: 'لقد بلغت حد استخدام Claude Code. سيُعاد ضبطه في {time}.',
  ccOverloaded:
    'واجهة Claude البرمجية محمّلة فوق طاقتها (HTTP {status})؛ توقف Claude Code عن إعادة المحاولة.',
  ccNotSignedIn:
    'Claude Code غير مسجّل الدخول، أو لا يمكن لهذا الحساب استخدامه هنا. شغّل `claude auth login` في الطرفية ثم حاول مرة أخرى.',
  ccBilling:
    'يوجد في حساب Claude الخاص بك مشكلة في الفوترة أو أنه معلّق. تحقق منه على claude.ai ثم حاول مرة أخرى.',
  ccPromptTooLong: 'لم تعد المحادثة تتسع في النموذج. ابدأ محادثة جديدة ثم حاول مرة أخرى.',
  ccNetwork: 'تعذّر على Claude Code الوصول إلى الشبكة.',
  ccTimeout: 'انتهت مهلة Claude Code أثناء انتظار النموذج.',
  ccTurnLimit: 'بلغ Claude Code حد الأدوار الخاص به لهذا الطلب.',
  ccEndedWith: 'أنهى Claude Code الدور بالنتيجة "{subtype}".',
} satisfies Record<keyof typeof zh, string>
