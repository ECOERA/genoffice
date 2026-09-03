import type { zh } from './zh'

export const es = {
  ccNotInstalled:
    'No se encontró Claude Code en este equipo. Instálalo, ejecuta `claude auth login` y vuelve a intentarlo.',
  ccUsageLimit: 'Has alcanzado tu límite de uso de Claude Code.',
  ccUsageLimitResets: 'Has alcanzado tu límite de uso de Claude Code. Se restablece a las {time}.',
  ccOverloaded:
    'La API de Claude está sobrecargada (HTTP {status}); Claude Code dejó de reintentar.',
  ccNotSignedIn:
    'Claude Code no ha iniciado sesión, o esta cuenta no puede usarlo aquí. Ejecuta `claude auth login` en una terminal y vuelve a intentarlo.',
  ccBilling:
    'Tu cuenta de Claude tiene un problema de facturación o está suspendida. Revísala en claude.ai y vuelve a intentarlo.',
  ccPromptTooLong:
    'La conversación ya no cabe en el modelo. Inicia un chat nuevo y vuelve a intentarlo.',
  ccNetwork: 'Claude Code no pudo conectarse a la red.',
  ccTimeout: 'Claude Code agotó el tiempo de espera del modelo.',
  ccTurnLimit: 'Claude Code alcanzó su propio límite de turnos para esta solicitud.',
  ccEndedWith: 'Claude Code terminó el turno con «{subtype}».',
} satisfies Record<keyof typeof zh, string>
