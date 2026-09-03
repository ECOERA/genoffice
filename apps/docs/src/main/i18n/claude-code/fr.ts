import type { zh } from './zh'

export const fr = {
  ccNotInstalled:
    'Claude Code est introuvable sur cet ordinateur. Installez-le, exécutez `claude auth login`, puis réessayez.',
  ccUsageLimit: "Votre quota d'utilisation de Claude Code est atteint.",
  ccUsageLimitResets:
    "Votre quota d'utilisation de Claude Code est atteint. Il se réinitialise à {time}.",
  ccOverloaded:
    "L'API de Claude est surchargée (HTTP {status}) ; Claude Code a cessé de réessayer.",
  ccNotSignedIn:
    "Claude Code n'est pas connecté, ou ce compte ne peut pas l'utiliser ici. Exécutez `claude auth login` dans un terminal, puis réessayez.",
  ccBilling:
    'Votre compte Claude a un problème de facturation ou est suspendu. Vérifiez-le sur claude.ai, puis réessayez.',
  ccPromptTooLong:
    'La conversation dépasse la capacité du modèle. Commencez une nouvelle discussion, puis réessayez.',
  ccNetwork: "Claude Code n'a pas pu accéder au réseau.",
  ccTimeout: 'Claude Code a expiré en attendant le modèle.',
  ccTurnLimit: 'Claude Code a atteint sa propre limite de tours pour cette requête.',
  ccEndedWith: 'Claude Code a terminé le tour avec « {subtype} ».',
} satisfies Record<keyof typeof zh, string>
