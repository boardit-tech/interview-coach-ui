import {
  streamCoachResponse,
  extractStarSections,
  type ConversationMessage
} from './claude';

const STAR_KEYS = ['situation', 'task', 'action', 'result'] as const;

// Spoken verbatim when the fourth section turns green. Mirrors the Phase 6 wording in
// COACH_SYSTEM_PROMPT so the moment reads the same as before — minus the recap.
const HANDBACK_LINE =
  "We've got good material for all four parts of your story now. Is there anything you'd like to add or revisit? Or if you're happy with where we are, we can wrap up and I'll polish it into a final version.";

const SESSION_LIMIT_MS = 20 * 60 * 1000; // 20 minutes

export interface StarSections {
  situation: string | null;
  task: string | null;
  action: string | null;
  result: string | null;
}

export interface Session {
  id: string;
  status: 'active' | 'completed' | 'story_ready';
  conversationHistory: ConversationMessage[];
  starSections: StarSections;
  extractedQuestion: string | null;
  targetCompany: string | null;
  extractedFlags: Array<{ flag: string; suggestion: string }> | null;
  startedAt: string;
  completedAt: string | null;
  report: any;
}

// In-memory cache (fast path — may be empty on serverless cold start)
const sessions = new Map<string, Session>();

// ── Load session: Supabase is the source of truth ──
//
// This used to return the in-memory copy whenever one existed, which silently
// rewound conversations. Vercel Edge keeps several warm instances, each with its own
// module-level Map, and turns alternate between them:
//
//   instance A  turns 1-2  -> its memory holds 2, persists 2
//   instance B  turn 3     -> cold, loads 2 from DB, appends, persists 3
//   instance A  turn 4     -> memory STILL holds 2, appends, persists 3
//
// A's write overwrites turn 3 — the user's words disappear, and anything captured
// during that turn (the target company, an extracted question) disappears with them.
// The cache is now only a fallback for when the database read fails.
async function loadSession(sessionId: string, supabase: any): Promise<Session | null> {
  const cached = sessions.get(sessionId);

  const { data, error } = await supabase
    .from('session_logs')
    .select('session_id, created_at, status, conversation_history, star_sections, extracted_question, extracted_flags, target_company')
    .eq('session_id', sessionId)
    .single();

  // Only fall back to the cached copy if the DB is unreachable — never because it
  // merely looks older, which is exactly the mistake that lost turns.
  if (error || !data) return cached ?? null;

  const session: Session = {
    id: data.session_id,
    status: data.status === 'started' ? 'active' : data.status,
    conversationHistory: data.conversation_history || [],
    starSections: data.star_sections || { situation: null, task: null, action: null, result: null },
    extractedQuestion: data.extracted_question || null,
    targetCompany: data.target_company || null,
    extractedFlags: data.extracted_flags || null,
    startedAt: data.created_at,
    completedAt: null,
    report: null,
  };

  // Cache it for this instance
  sessions.set(sessionId, session);
  return session;
}

// ── Persist session state to Supabase ──
async function persistSession(sessionId: string, session: Session, supabase: any) {
  try {
    const { error } = await supabase
      .from('session_logs')
      .update({
        conversation_history: session.conversationHistory,
        star_sections: session.starSections,
        extracted_question: session.extractedQuestion,
        target_company: session.targetCompany,
        extracted_flags: session.extractedFlags,
      })
      .eq('session_id', sessionId);
    if (error) console.error('Failed to persist session state:', error.message);
  } catch (err: any) {
    console.error('persistSession exception:', err.message);
  }
}

export function createSession(): Session {
  const id = `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const session: Session = {
    id,
    status: 'active',
    conversationHistory: [],
    starSections: { situation: null, task: null, action: null, result: null },
    extractedQuestion: null,
    targetCompany: null,
    extractedFlags: null,
    startedAt: new Date().toISOString(),
    completedAt: null,
    report: null,
  };

  sessions.set(id, session);
  return session;
}

export function getSession(id: string): Session | undefined {
  return sessions.get(id);
}

/** The target company captured by the extractor, for the end-of-session summary. */
export async function getSessionTargetCompany(sessionId: string, supabase: any): Promise<string | null> {
  const session = await loadSession(sessionId, supabase);
  return session?.targetCompany ?? null;
}

export async function startSession(sessionId: string, supabase: any): Promise<string> {
  const session = await loadSession(sessionId, supabase);
  if (!session) throw new Error('Session not found');

  // Kept short on purpose — this is read aloud, so every extra sentence is dead
  // airtime before the user can start. Theme suggestions are offered by the coach
  // only if the user asks for a recommendation.
  const openingMessage = `Hey! We have 20 minutes to deliver an impactful STAR story. Do you have a specific question in mind, or would you like my recommendation?`;

  session.conversationHistory.push({
    role: 'assistant',
    content: openingMessage,
  });

  // Persist opening message to Supabase
  await persistSession(sessionId, session, supabase);

  return openingMessage;
}

// ── Streaming handler (writes SSE to a writable controller) ──
export async function handleUserMessageStream(
  sessionId: string,
  userMessage: string,
  writer: { write: (data: string) => void; end: () => void },
  supabase: any
) {
  const session = await loadSession(sessionId, supabase);
  if (!session) throw new Error('Session not found');
  if (session.status === 'completed') throw new Error('Session already completed');

  session.conversationHistory.push({
    role: 'user',
    content: userMessage,
  });

  const elapsed = Date.now() - new Date(session.startedAt).getTime();
  if (elapsed >= SESSION_LIMIT_MS) {
    const closingMessage = "We're at the 20-minute mark! Let me wrap up what we have and put together your story report.";
    session.conversationHistory.push({ role: 'assistant', content: closingMessage });
    session.status = 'completed';
    session.completedAt = new Date().toISOString();
    await persistSession(sessionId, session, supabase);
    writer.write(`data: ${JSON.stringify({ type: 'chunk', text: closingMessage })}\n\n`);
    writer.write(`data: ${JSON.stringify({ type: 'done', message: closingMessage, done: true, remainingMs: 0 })}\n\n`);
    writer.end();
    return;
  }

  const elapsedMinutes = elapsed / 60000;

  // Hand-back is driven from code, not from the prompt. COACH_SYSTEM_PROMPT already
  // says "Do NOT read back or recap the full STAR story", and the coach is handed the
  // section states directly — it has both the rule and the information, and recaps
  // anyway. Reading the whole story aloud costs ~90-120s of a 20-minute session and
  // ~$0.035 of TTS to narrate something already visible in the sidebar. So when all
  // four sections are green we skip the model entirely for one turn and speak a fixed
  // line: no API call, no discretion to override.
  //
  // The "already handed back" flag is DERIVED from the transcript rather than held in
  // memory. An in-memory flag wouldn't survive a cold Edge instance, and two instances
  // would each fire it once — the same failure shape as the session-cache data loss.
  const allGreen = STAR_KEYS.every(k => !!session.starSections[k]);
  const alreadyHandedBack = session.conversationHistory.some(
    m => m.role === 'assistant' && m.content === HANDBACK_LINE
  );

  let coachResponse: string;
  if (allGreen && !alreadyHandedBack) {
    coachResponse = HANDBACK_LINE;
    writer.write(`data: ${JSON.stringify({ type: 'chunk', text: coachResponse })}\n\n`);
  } else {
    coachResponse = await streamCoachResponse(
      session.conversationHistory,
      elapsedMinutes,
      sessionId,
      (chunk) => {
        writer.write(`data: ${JSON.stringify({ type: 'chunk', text: chunk })}\n\n`);
      },
      session.starSections,
      supabase,
      session.targetCompany
    );
  }

  session.conversationHistory.push({
    role: 'assistant',
    content: coachResponse,
  });

  const remainingMs = Math.max(0, SESSION_LIMIT_MS - (Date.now() - new Date(session.startedAt).getTime()));

  // Send the coach's conversational reply immediately
  writer.write(`data: ${JSON.stringify({
    type: 'done',
    message: coachResponse,
    done: false,
    remainingMs,
  })}\n\n`);

  // Persist after coach reply (fire-and-forget)
  await persistSession(sessionId, session, supabase);

  // Run STAR extraction — must await so Vercel Edge doesn't terminate early
  const userMsgCount = session.conversationHistory.filter(m => m.role === 'user').length;
  if (userMsgCount >= 1) {
    try {
      const sections = await extractStarSections(session.conversationHistory, sessionId, supabase);
      if (sections) {
        const updates: { section: string; content: string }[] = [];
        if (sections.question) {
          session.extractedQuestion = sections.question;
        }
        // Captured once, then reused for the rest of the session by the coach and
        // the summary — no re-scanning the transcript.
        if (sections.targetCompany) {
          session.targetCompany = sections.targetCompany;
        }
        if (sections.flags) {
          session.extractedFlags = sections.flags;
        }
        for (const key of ['situation', 'task', 'action', 'result'] as const) {
          if (sections[key] && sections[key] !== session.starSections[key]) {
            // The extractor regenerates each section from scratch rather than editing
            // it, so a fact captured earlier can silently vanish from a later version
            // even though it's still in the transcript. That failure is invisible —
            // the section still reads fine. Log dropped numbers (the highest-value and
            // most detectable facts) so we can find out whether this actually happens
            // before deciding whether it needs guarding. Diagnostic only: nothing
            // branches on it.
            const prev = session.starSections[key];
            if (prev) {
              const numbersIn = (t: string) => new Set(t.match(/\d[\d,.]*%?/g) ?? []);
              const after = numbersIn(sections[key]!);
              const dropped = [...numbersIn(prev)].filter(n => !after.has(n));
              if (dropped.length) {
                console.warn(
                  `[section-drop] session=${sessionId} section=${key} dropped=${dropped.join('|')}`
                );
              }
            }
            session.starSections[key] = sections[key];
            updates.push({ section: key, content: sections[key]! });
          }
        }
        writer.write(`data: ${JSON.stringify({ type: 'star_update', updates, status: sections.status, question: sections.question || null, flags: sections.flags || null })}\n\n`);
        await persistSession(sessionId, session, supabase);
      }
    } catch (err: any) {
      console.warn('STAR extraction failed:', err.message);
    }
  }
  writer.end();
}

export async function endSession(sessionId: string, supabase: any) {
  const session = await loadSession(sessionId, supabase);
  if (!session) throw new Error('Session not found');

  session.status = 'completed';
  session.completedAt = new Date().toISOString();

  const durationMs = session.completedAt && session.startedAt
    ? new Date(session.completedAt).getTime() - new Date(session.startedAt).getTime()
    : null;

  return { completed: true, durationMs };
}

// Final extraction pass — runs one last extraction over the FULL transcript at
// session end, so the sidebar reflects the user's last messages (the per-turn
// extraction can miss a final answer given while the coach was still streaming).
// Returns the fresh sections and persists them as the authoritative final state.
export async function finalizeStarExtraction(sessionId: string, supabase: any) {
  const session = await loadSession(sessionId, supabase);
  if (!session) return null;

  const sections = await extractStarSections(session.conversationHistory, sessionId, supabase);
  if (sections) {
    if (sections.question) session.extractedQuestion = sections.question;
    if (sections.flags) session.extractedFlags = sections.flags;
    session.starSections = {
      situation: sections.situation ?? null,
      task: sections.task ?? null,
      action: sections.action ?? null,
      result: sections.result ?? null,
    };
    await persistSession(sessionId, session, supabase);
  }
  return sections;
}
