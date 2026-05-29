export const ko = {
  app: {
    title: "Claude Code 세션 모니터",
    legend: "범례",
    legendLive: "LIVE(<60s)",
    legendIdle: "idle(<10m)",
    legendStop: "stop",
    noSessions: "활동 세션 없음",
    connectionLost: "연결 끊김 — 재연결 중…",
    showAll: "전체",
    maxAge: "최근",
  },
  card: {
    tool: "도구",
    subagent: "sub-agent",
    todo: "todo",
    todoCurrent: "진행",
    todoNext: "다음",
    msg: "msg",
    context: "컨텍스트",
  },
  runner: {
    conductor: "Conductor",
    "claude-code": "Claude Code",
    "claude-desktop": "Claude Desktop",
    unknown: "—",
  },
  filter: {
    last1h: "1h",
    last24h: "24h",
    last7d: "7d",
    all: "전체",
    projectFilter: "프로젝트 필터",
  },
} as const;

export type Locale = typeof ko;
