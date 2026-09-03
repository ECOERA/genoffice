import type { zh } from './zh'

export const hi = {
  ccNotInstalled:
    'इस कंप्यूटर पर Claude Code नहीं मिला। इसे इंस्टॉल करें, `claude auth login` चलाएँ, फिर दोबारा कोशिश करें।',
  ccUsageLimit: 'आपकी Claude Code उपयोग सीमा पूरी हो गई है।',
  ccUsageLimitResets: 'आपकी Claude Code उपयोग सीमा पूरी हो गई है। यह {time} पर रीसेट होगी।',
  ccOverloaded:
    'Claude का API ओवरलोड है (HTTP {status}); Claude Code ने दोबारा कोशिश करना बंद कर दिया।',
  ccNotSignedIn:
    'Claude Code साइन इन नहीं है, या यह खाता इसे यहाँ इस्तेमाल नहीं कर सकता। टर्मिनल में `claude auth login` चलाएँ, फिर दोबारा कोशिश करें।',
  ccBilling:
    'आपके Claude खाते में बिलिंग समस्या है या वह रोका गया है। claude.ai पर जाँचें, फिर दोबारा कोशिश करें।',
  ccPromptTooLong:
    'बातचीत अब मॉडल की सीमा में नहीं समाती। नई चैट शुरू करें, फिर दोबारा कोशिश करें।',
  ccNetwork: 'Claude Code नेटवर्क से संपर्क नहीं कर सका।',
  ccTimeout: 'मॉडल की प्रतीक्षा में Claude Code का समय समाप्त हो गया।',
  ccTurnLimit: 'Claude Code इस अनुरोध के लिए अपनी टर्न सीमा तक पहुँच गया।',
  ccEndedWith: 'Claude Code ने टर्न "{subtype}" के साथ समाप्त किया।',
} satisfies Record<keyof typeof zh, string>
