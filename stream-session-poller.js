(function () {
  'use strict';

  const Stream = window.OwnChatStream;

  function createProgressState(seed = {}) {
    const now = Date.now();
    return {
      streamStartTime: numberOr(seed.streamStartTime, now),
      firstTokenTime: nullableNumber(seed.firstTokenTime),
      outputStartTime: nullableNumber(seed.outputStartTime),
      reasoningStartTime: nullableNumber(seed.reasoningStartTime),
      reasoningEndTime: nullableNumber(seed.reasoningEndTime),
      lastContent: seed.lastContent || '',
    };
  }

  function numberOr(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function nullableNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function normalizeSession(session) {
    return {
      content: session?.assistantContent || '',
      reasoning: session?.reasoningContent || '',
      usage: Stream.normalizeUsage(session?.usage),
      status: session?.status || '',
    };
  }

  function isTerminalSession(session) {
    return session?.status === 'complete' || session?.status === 'error' || session?.status === 'stopped';
  }

  function applyProgress(state, session, now = Date.now()) {
    const progress = normalizeSession(session);

    if (progress.content && state.firstTokenTime === null) {
      state.firstTokenTime = now - state.streamStartTime;
      state.outputStartTime = now;
    }
    if (progress.reasoning && state.reasoningStartTime === null) {
      state.reasoningStartTime = now;
    }
    if (progress.reasoning && progress.content && state.reasoningEndTime === null) {
      state.reasoningEndTime = now;
    }

    const contentChanged = progress.content !== state.lastContent;
    if (contentChanged) state.lastContent = progress.content;

    return Object.assign({ contentChanged }, progress);
  }

  function outputTimeMs(state, session, endedAt = Date.now()) {
    const sessionOutputTimeMs = session?.outputTimeMs != null ? Number(session.outputTimeMs) : null;
    if (Number.isFinite(sessionOutputTimeMs)) return sessionOutputTimeMs;
    const localOutputTimeMs = state.outputStartTime ? endedAt - state.outputStartTime : null;
    return Number.isFinite(localOutputTimeMs) ? localOutputTimeMs : null;
  }

  function reasoningTimeMs(state) {
    if (state.reasoningEndTime === null) return null;
    return state.reasoningEndTime - (state.reasoningStartTime || state.streamStartTime);
  }

  function ensureSessionOutputTime(session, state, now = Date.now()) {
    if (!session || session.outputTimeMs != null) return;
    const time = outputTimeMs(state, session, now);
    if (Number.isFinite(time)) session.outputTimeMs = time;
  }

  window.OwnChatStreamSessionPoller = {
    createProgressState,
    normalizeSession,
    isTerminalSession,
    applyProgress,
    outputTimeMs,
    reasoningTimeMs,
    ensureSessionOutputTime,
  };
})();
