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

export type SectionState = 'green' | 'yellow' | null;
export interface StarStatus {
  situation: SectionState;
  task: SectionState;
  action: SectionState;
  result: SectionState;
}

const EMPTY_SECTIONS = (): StarSections => ({ situation: null, task: null, action: null, result: null });
const EMPTY_STATUS = (): StarStatus => ({ situation: null, task: null, action: null, result: null });

// One contiguous run of turns (indices into the STORY transcript) that belong to a
// single experience. `exp` groups runs: switching back to an earlier experience
// opens a new run with that experience's number, so its turns can be
// non-contiguous. The last run is always open (to = null). An empty list means
// "everything is one experience".
export interface ExperienceSegment {
  from: number;
  to: number | null;
  exp: number;
}

// A story is the persistent object; a session is one sitting of work on it.
// STAR state lives HERE, not on the session, so a resumed session starts where
// the last one ended.
export interface Story {
  id: string;
  status: 'in_progress' | 'complete';
  starSections: StarSections;
  starStatus: StarStatus;
  extractedQuestion: string | null;
  targetCompany: string | null;
  extractedFlags: Array<{ flag: string; suggestion: string }> | null;
  experienceSegments: ExperienceSegment[];
  // One-tab lock: which session currently holds this story (null = none).
  activeSessionId: string | null;
  // Every earlier session's transcript for this story, in order. The current
  // session's turns are appended to this to form the story transcript.
  priorHistory: ConversationMessage[];
  updatedAt: string;
}

export interface Session {
  id: string;
  storyId: string | null;
  status: 'active' | 'completed' | 'story_ready';
  conversationHistory: ConversationMessage[];
  // Mirrors of the story's state (copied in at load, written back to both the
  // story and this session's row at persist). For a session with no story —
  // anything created before stories became persistent — these ARE the state.
  starSections: StarSections;
  starStatus: StarStatus;
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
    .select('session_id, story_id, created_at, status, conversation_history, star_sections, extracted_question, extracted_flags, target_company')
    .eq('session_id', sessionId)
    .single();

  // Only fall back to the cached copy if the DB is unreachable — never because it
  // merely looks older, which is exactly the mistake that lost turns.
  if (error || !data) return cached ?? null;

  const session: Session = {
    id: data.session_id,
    storyId: data.story_id || null,
    status: data.status === 'started' ? 'active' : data.status,
    conversationHistory: data.conversation_history || [],
    starSections: data.star_sections || EMPTY_SECTIONS(),
    starStatus: EMPTY_STATUS(),
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

// ── Load the story behind a session, and adopt its state ──
//
// Returns null (and leaves the session's own state in place) when the session has
// no story — the pre-resumability shape — or when the story read fails, in which
// case the session's per-row snapshot is the best state we have.
async function loadStory(session: Session, supabase: any): Promise<Story | null> {
  if (!session.storyId) return null;

  const [{ data: s, error: sErr }, { data: logs, error: lErr }] = await Promise.all([
    supabase
      .from('stories')
      .select('id, status, star_sections, star_status, extracted_question, target_company, extracted_flags, experience_segments, active_session_id, updated_at')
      .eq('id', session.storyId)
      .single(),
    supabase
      .from('session_logs')
      .select('session_id, conversation_history, created_at')
      .eq('story_id', session.storyId)
      .neq('session_id', session.id)
      .order('created_at', { ascending: true }),
  ]);

  if (sErr || !s) {
    console.error('loadStory failed:', sErr?.message ?? 'no row');
    return null;
  }
  if (lErr) console.error('loadStory: prior sessions read failed:', lErr.message);

  const story: Story = {
    id: s.id,
    status: s.status,
    starSections: s.star_sections || EMPTY_SECTIONS(),
    starStatus: s.star_status || EMPTY_STATUS(),
    extractedQuestion: s.extracted_question || null,
    targetCompany: s.target_company || null,
    extractedFlags: s.extracted_flags || null,
    experienceSegments: Array.isArray(s.experience_segments) ? s.experience_segments : [],
    activeSessionId: s.active_session_id || null,
    priorHistory: (logs ?? []).flatMap((l: any) => l.conversation_history || []),
    updatedAt: s.updated_at,
  };

  // The story is authoritative. Copy its state onto the session so the rest of the
  // turn logic reads one place, then persistSession writes it back to both.
  session.starSections = { ...story.starSections };
  session.starStatus = { ...story.starStatus };
  session.extractedQuestion = story.extractedQuestion;
  session.targetCompany = story.targetCompany;
  session.extractedFlags = story.extractedFlags;

  return story;
}

// The full transcript the COACH sees: every earlier sitting, then this one.
function storyTranscript(session: Session, story: Story | null): ConversationMessage[] {
  return story ? [...story.priorHistory, ...session.conversationHistory] : session.conversationHistory;
}

// The transcript the EXTRACTOR sees: only the turns of the currently active
// experience. The coach keeps the whole thing (it needs the abandoned experience
// for context — "that one had no clear result, so let's make sure this one does");
// the extractor must never see it, or it will blend two experiences into one story.
export function activeExperienceTurns(
  transcript: ConversationMessage[],
  segments: ExperienceSegment[]
): ConversationMessage[] {
  if (segments.length === 0) return transcript;
  const activeExp = segments[segments.length - 1].exp;
  const out: ConversationMessage[] = [];
  for (const seg of segments) {
    if (seg.exp !== activeExp) continue;
    out.push(...transcript.slice(seg.from, seg.to ?? transcript.length));
  }
  return out;
}

// ── Persist session state (and, when there is one, the story's) to Supabase ──
//
// The session row keeps a per-sitting snapshot of the STAR fields: the dashboard's
// session list and star_sections_filled read it, and it costs nothing. The story
// row is what the next session resumes from.
async function persistSession(sessionId: string, session: Session, supabase: any, story?: Story | null) {
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

  if (!story) return;
  try {
    const { error } = await supabase
      .from('stories')
      .update({
        star_sections: session.starSections,
        star_status: session.starStatus,
        extracted_question: session.extractedQuestion,
        target_company: session.targetCompany,
        extracted_flags: session.extractedFlags,
        experience_segments: story.experienceSegments,
        updated_at: new Date().toISOString(),
      })
      .eq('id', story.id);
    if (error) console.error('Failed to persist story state:', error.message);
  } catch (err: any) {
    console.error('persistStory exception:', err.message);
  }
}

export function createSession(storyId: string | null = null): Session {
  const id = `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const session: Session = {
    id,
    storyId,
    status: 'active',
    conversationHistory: [],
    starSections: EMPTY_SECTIONS(),
    starStatus: EMPTY_STATUS(),
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
  if (!session) return null;
  await loadStory(session, supabase);
  return session.targetCompany ?? null;
}

const SECTION_LABEL: Record<typeof STAR_KEYS[number], string> = {
  situation: 'the Situation', task: 'the Task', action: 'the Action', result: 'the Result',
};

// A gap shorter than this is "I refreshed the page" — re-narrating context to
// someone who was here two minutes ago is silly. Longer than this and they have
// genuinely come back, so orient them.
const RESUME_RECAP_GAP_MS = 10 * 60 * 1000;

// Fresh vs. resumed opening lines. Kept short on purpose — this is read aloud, so
// every extra sentence is dead airtime before the user can start. Theme
// suggestions are offered by the coach only if the user asks.
function buildOpening(story: Story | null, resumed: boolean): string {
  if (!resumed || !story) {
    return `Hey! We have 20 minutes to deliver an impactful STAR story. Do you have a specific question in mind, or would you like my recommendation?`;
  }

  const gapMs = Date.now() - new Date(story.updatedAt).getTime();
  if (gapMs < RESUME_RECAP_GAP_MS) {
    return `Welcome back — let's pick up right where we left off.`;
  }

  if (!story.extractedQuestion) {
    return `Welcome back! Last time we were still exploring which experience to build on. Let's pick that up — what were you thinking?`;
  }

  const green = STAR_KEYS.filter(k => !!story.starSections[k]);
  const next = STAR_KEYS.find(k => !story.starSections[k]);
  const intro = `Welcome back! We're picking up your story for the question: ${story.extractedQuestion}`;

  if (!next) {
    return `${intro} All four parts are already solid, so this sitting is for polishing. What would you like to sharpen?`;
  }
  if (green.length === 0) {
    return `${intro} Let's start building ${SECTION_LABEL[next]}. Ready when you are.`;
  }
  const solid = green.map(k => SECTION_LABEL[k]).join(green.length === 2 ? ' and ' : ', ');
  return `${intro} So far ${solid} ${green.length === 1 ? 'is' : 'are'} solid. Let's keep going with ${SECTION_LABEL[next]}. Ready when you are.`;
}

export async function startSession(
  sessionId: string,
  supabase: any,
  opts: { resumed?: boolean } = {}
): Promise<string> {
  const session = await loadSession(sessionId, supabase);
  if (!session) throw new Error('Session not found');
  const story = await loadStory(session, supabase);

  const openingMessage = buildOpening(story, !!opts.resumed);

  session.conversationHistory.push({
    role: 'assistant',
    content: openingMessage,
  });

  // Persist opening message to Supabase
  await persistSession(sessionId, session, supabase, story);

  return openingMessage;
}

// Apply one extractor result to the session/story state. Returns the section
// updates that actually changed (for the client's sidebar).
function applyExtraction(
  session: Session,
  sections: NonNullable<Awaited<ReturnType<typeof extractStarSections>>>,
  sessionId: string
): { section: string; content: string }[] {
  const updates: { section: string; content: string }[] = [];

  // The question is locked once captured — for the life of the story. It is the
  // thing that defines what this story IS; the off-topic guard measures against it.
  if (sections.question && !session.extractedQuestion) {
    session.extractedQuestion = sections.question;
  }
  // Captured once, then reused for the rest of the story by the coach and the
  // summary — no re-scanning the transcript.
  if (sections.targetCompany && !session.targetCompany) {
    session.targetCompany = sections.targetCompany;
  }
  if (sections.flags) {
    session.extractedFlags = sections.flags;
  }
  // Green text is authoritative: once a section has interview-ready text it stays
  // green, even if a later extractor run over the same transcript is stricter.
  // Regeneration is from scratch each turn, so without this a section could flip
  // green -> yellow -> green with no new input, which reads as the app losing work.
  session.starStatus = { ...sections.status };
  for (const key of STAR_KEYS) {
    if (session.starSections[key]) session.starStatus[key] = 'green';
  }

  for (const key of STAR_KEYS) {
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
  return updates;
}

// Thrown by handleUserMessageStream when another tab has taken this story over.
// The respond endpoint turns it into a typed SSE error so the client can show its
// in-page card instead of a generic failure.
export class SupersededError extends Error {
  constructor(public readonly heldBy: string) {
    super('superseded');
  }
}

// Release the one-tab lock if THIS session holds it. Idempotent: a session that
// doesn't hold it (already taken over, or never locked) is a no-op.
async function releaseLock(session: Session, supabase: any) {
  if (!session.storyId) return;
  const { error } = await supabase.rpc('release_story_session', {
    p_story_id: session.storyId,
    p_session_id: session.id,
  });
  if (error) console.error('release_story_session failed:', error.message);
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
  const story = await loadStory(session, supabase);

  // Second layer of takeover enforcement (the heartbeat is the first). Without
  // this, a tab that lost the lock keeps appending turns and produces exactly the
  // interleaved transcript the lock exists to prevent. Checked on EVERY turn, not
  // just at start. Its turn is dropped, not recorded.
  if (story && story.activeSessionId && story.activeSessionId !== session.id) {
    await supabase.from('session_logs').update({ status: 'abandoned' }).eq('session_id', session.id);
    throw new SupersededError(story.activeSessionId);
  }

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
    await persistSession(sessionId, session, supabase, story);
    await releaseLock(session, supabase);
    writer.write(`data: ${JSON.stringify({ type: 'chunk', text: closingMessage })}\n\n`);
    writer.write(`data: ${JSON.stringify({ type: 'done', message: closingMessage, done: true, remainingMs: 0 })}\n\n`);
    writer.end();
    return;
  }

  const elapsedMinutes = elapsed / 60000;
  const transcript = storyTranscript(session, story);

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
  // It is checked over the whole STORY transcript, so it fires once per story, not
  // once per sitting.
  const allGreen = STAR_KEYS.every(k => !!session.starSections[k]);
  const alreadyHandedBack = transcript.some(
    m => m.role === 'assistant' && m.content === HANDBACK_LINE
  );

  let coachResponse: string;
  if (allGreen && !alreadyHandedBack) {
    coachResponse = HANDBACK_LINE;
    writer.write(`data: ${JSON.stringify({ type: 'chunk', text: coachResponse })}\n\n`);
  } else {
    coachResponse = await streamCoachResponse(
      transcript,
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
  await persistSession(sessionId, session, supabase, story);

  // Run STAR extraction — must await so Vercel Edge doesn't terminate early
  const userMsgCount = session.conversationHistory.filter(m => m.role === 'user').length;
  if (userMsgCount >= 1) {
    try {
      const extractorInput = activeExperienceTurns(
        storyTranscript(session, story),
        story?.experienceSegments ?? []
      );
      const sections = await extractStarSections(extractorInput, sessionId, supabase);
      if (sections) {
        const updates = applyExtraction(session, sections, sessionId);
        writer.write(`data: ${JSON.stringify({
          type: 'star_update',
          updates,
          status: sections.status,
          question: session.extractedQuestion,
          flags: sections.flags || null,
        })}\n\n`);
        await persistSession(sessionId, session, supabase, story);
      }
    } catch (err: any) {
      console.warn('STAR extraction failed:', err.message);
    }
  }
  writer.end();
}

/**
 * Everything the end-of-session assessment needs, read server-side. The client
 * used to send its own copy of the transcript and sections; under resume that copy
 * only covers the current sitting, and it was never something to trust anyway.
 */
export async function getStoryContext(sessionId: string, supabase: any) {
  const session = await loadSession(sessionId, supabase);
  if (!session) return null;
  const story = await loadStory(session, supabase);
  return {
    storyId: session.storyId,
    // Same view as the extractor: only the active experience. The summary is about
    // THIS story, so an experience abandoned early must not leak into its talking
    // points or cited strengths.
    transcript: activeExperienceTurns(storyTranscript(session, story), story?.experienceSegments ?? []),
    starSections: { ...session.starSections },
    starStatus: { ...session.starStatus },
    question: session.extractedQuestion,
    targetCompany: session.targetCompany,
  };
}

export async function endSession(sessionId: string, supabase: any) {
  const session = await loadSession(sessionId, supabase);
  if (!session) throw new Error('Session not found');

  session.status = 'completed';
  session.completedAt = new Date().toISOString();
  await releaseLock(session, supabase);

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
  const story = await loadStory(session, supabase);

  const extractorInput = activeExperienceTurns(
    storyTranscript(session, story),
    story?.experienceSegments ?? []
  );
  const sections = await extractStarSections(extractorInput, sessionId, supabase);
  if (sections) {
    applyExtraction(session, sections, sessionId);
    await persistSession(sessionId, session, supabase, story);
  }
  return sections;
}
