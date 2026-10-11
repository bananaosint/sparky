// The window's mission requests, checked and routed. main.js passes in the live pieces: the
// runner, the picked model, whether a marathon runs, and how to start, stop or restart Claude Code.
export async function missionRequest(request, { missions, model, marathonRunning, sessionId, ensureClaude, stopTurn, restart, notUser }) {
  if (!missions) return { error: 'no folder is open, or missions are off in this folder' };
  const { action, id } = request ?? {};
  if ((action === 'start' || action === 'resume') && marathonRunning) return { error: 'a marathon is running: /marathon stop ends it first' };
  if (action === 'start') {
    if (model === 'gemini' || model === 'auto') return { error: 'a mission needs Claude Code: pick a Claude model or UltraCode first' };
    ensureClaude();
    notUser();
    return missions.start(String(request.objective ?? ''), { sessionId });
  }
  if (action === 'approve') {
    // Claude Code may have exited while the criteria waited: the run message needs a process.
    ensureClaude();
    notUser();
    return missions.approve(id, request.criteria);
  }
  if (action === 'cancel') {
    const out = missions.cancel(id);
    if (out.stop) stopTurn();
    return out;
  }
  if (action === 'resume') {
    notUser();
    return missions.resume(id, restart);
  }
  return { error: 'unknown mission action' };
}
