import type { zh } from './zh'

export const pt = {
  ccNotInstalled:
    'O Claude Code não foi encontrado neste computador. Instale-o, execute `claude auth login` e tente novamente.',
  ccUsageLimit: 'Seu limite de uso do Claude Code foi atingido.',
  ccUsageLimitResets: 'Seu limite de uso do Claude Code foi atingido. Ele é redefinido às {time}.',
  ccOverloaded:
    'A API do Claude está sobrecarregada (HTTP {status}); o Claude Code desistiu de tentar novamente.',
  ccNotSignedIn:
    'O Claude Code não está conectado, ou esta conta não pode usá-lo aqui. Execute `claude auth login` em um terminal e tente novamente.',
  ccBilling:
    'Sua conta Claude tem um problema de cobrança ou está suspensa. Verifique em claude.ai e tente novamente.',
  ccPromptTooLong: 'A conversa não cabe mais no modelo. Inicie um novo chat e tente novamente.',
  ccNetwork: 'O Claude Code não conseguiu acessar a rede.',
  ccTimeout: 'O Claude Code excedeu o tempo de espera pelo modelo.',
  ccTurnLimit: 'O Claude Code atingiu seu próprio limite de turnos para esta solicitação.',
  ccEndedWith: 'O Claude Code encerrou o turno com "{subtype}".',
} satisfies Record<keyof typeof zh, string>
