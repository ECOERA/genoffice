import type { zh } from './zh'

export const ko = {
  ccNotInstalled:
    '이 컴퓨터에서 Claude Code를 찾을 수 없습니다. 설치한 뒤 `claude auth login`을 실행하고 다시 시도하세요.',
  ccUsageLimit: 'Claude Code 사용 한도에 도달했습니다.',
  ccUsageLimitResets: 'Claude Code 사용 한도에 도달했습니다. {time}에 초기화됩니다.',
  ccOverloaded:
    'Claude API가 과부하 상태입니다(HTTP {status}). Claude Code가 재시도를 중단했습니다.',
  ccNotSignedIn:
    'Claude Code에 로그인되어 있지 않거나 이 계정은 여기서 사용할 수 없습니다. 터미널에서 `claude auth login`을 실행한 뒤 다시 시도하세요.',
  ccBilling:
    'Claude 계정에 결제 문제가 있거나 보류 상태입니다. claude.ai에서 확인한 뒤 다시 시도하세요.',
  ccPromptTooLong: '대화가 모델의 한도를 초과했습니다. 새 채팅을 시작한 뒤 다시 시도하세요.',
  ccNetwork: 'Claude Code가 네트워크에 연결할 수 없습니다.',
  ccTimeout: 'Claude Code가 모델 응답을 기다리다 시간이 초과되었습니다.',
  ccTurnLimit: 'Claude Code가 이 요청의 자체 턴 한도에 도달했습니다.',
  ccEndedWith: 'Claude Code가 이 턴을 "{subtype}"(으)로 종료했습니다.',
} satisfies Record<keyof typeof zh, string>
