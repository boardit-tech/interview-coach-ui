<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { browser } from '$app/environment';
	import { goto, invalidate } from '$app/navigation';
	import { userStore } from '$lib/stores/userStore';

	// ── State ──
	let phase: 'lobby' | 'coaching' | 'loading-report' | 'report' = 'lobby';
	let sessionId: string | null = null;
	// STT diagnostics. A session that ends with no turns looks identical whether the
	// mic was broken or the user simply left — these are what tell them apart. Both
	// are captured here and sent with /api/end; nothing branches on them yet.
	let sttError: string | null = null;
	let sawSpeech = false;
	let messages: Array<{ role: string; content: string; streaming?: boolean }> = [];
	let loading = false;
	let report: any = null;
	let remainingTime = 20 * 60 * 1000;
	let userConfirmedEnd = false;
	let starSections: Record<string, string | null> = { situation: null, task: null, action: null, result: null };
	// Per-section readiness: 'green' (interview-ready) | 'yellow' (partial) | null (none)
	let starStatus: Record<string, 'green' | 'yellow' | null> = { situation: null, task: null, action: null, result: null };
	let extractedQuestion: string | null = null;
	let extractedFlags: Array<{ flag: string; suggestion: string }> | null = null;

	// ── Story (the persistent object a session works on) ──
	// storyId is what makes resume possible; it lives in the URL (?story=) so a
	// refresh resumes instead of silently creating a new story.
	export let data: {
		resumeStory: { id: string; status: 'in_progress' | 'complete'; question: string | null; green: number; updatedAt: string; expiresAt: string | null; expired: boolean } | null;
		plan: { storiesLeft: number; poolExpiresAt: string | null; hasAnyPurchase: boolean; allExpired: boolean } | null;
		credits: number;
	};
	// Why a NEW story can't start, if it can't. Pre-computed from the plan on load
	// and refreshed from the server's answer on a refused start.
	let blockedReason: 'no_stories' | 'window_ended' | 'no_purchase' | null = null;
	$: if (data?.plan && !$userStore.subscriptionID && data.plan.storiesLeft === 0 && (data.credits ?? 0) === 0) {
		blockedReason = data.plan.allExpired ? 'window_ended' : data.plan.hasAnyPurchase ? 'no_stories' : 'no_purchase';
	}
	const fmtDay = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
	const daysUntil = (iso: string) => Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000);
	// The window that governs THIS action: the story's own when resuming, the pool's when starting.
	$: governingExpiry = resumeStory ? resumeStory.expiresAt : data?.plan?.poolExpiresAt ?? null;
	$: windowEndsSoon = governingExpiry && daysUntil(governingExpiry) <= 7 && daysUntil(governingExpiry) >= 0 ? governingExpiry : null;

	let storyId: string | null = null;
	let resumeStoryId: string | null = null;   // read from ?story= on load
	let lockConflict = false;                  // another tab holds the story (409)
	let superseded = false;                    // this tab lost the story to another
	$: resumeStory = resumeStoryId && data?.resumeStory?.id === resumeStoryId ? data.resumeStory : null;
	let storyStatus: 'in_progress' | 'complete' = 'in_progress';
	let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

	function setStoryInUrl(id: string | null) {
		if (!browser) return;
		const url = new URL(window.location.href);
		if (id) url.searchParams.set('story', id); else url.searchParams.delete('story');
		history.replaceState(history.state, '', url.toString());
	}

	// Another tab took this story over. Quiet exit: no dialog, no TTS.
	function handleSuperseded() {
		if (sessionEnded) return;
		sessionEnded = true;
		stopListening();
		ttsStop();
		stopHeartbeat();
		stopIdleWatch();
		if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
		messages = messages.filter(m => !m.streaming);
		superseded = true;
	}

	async function sendHeartbeat() {
		if (!sessionId || !storyId || sessionEnded || phase !== 'coaching') return;
		try {
			const res = await fetch('/storybuilder/api/heartbeat', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ sessionId, storyId }),
			});
			if (!res.ok) return;
			const data = await res.json();
			if (data.replaced) handleSuperseded();
		} catch { /* transient — next beat will tell */ }
	}
	function startHeartbeat() {
		stopHeartbeat();
		heartbeatInterval = setInterval(sendHeartbeat, 30_000);
	}
	function stopHeartbeat() {
		if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
	}
	function handleVisibility() {
		if (document.visibilityState === 'visible') sendHeartbeat();
	}
	// Grounded end-of-session summary (per-section talking points + strong/missing,
	// cited strengths/growth, full story only when all green).
	let assessment: any = null;
	let assessmentLoading = false;
	let sidebarWidth = 380;
	let isListening = false;
	let isSpeaking = false;
	let interimTranscript = '';
	let browserSupported = true;
	let showTranscript = false;
	let starExpanded = false;
	let toast: { message: string; type: 'error' | 'success' | 'info' } | null = null;
	let toastTimeout: ReturnType<typeof setTimeout> | null = null;

	function showToast(message: string, type: 'error' | 'success' | 'info' = 'info', durationMs = 5000) {
		if (toastTimeout) clearTimeout(toastTimeout);
		toast = { message, type };
		toastTimeout = setTimeout(() => { toast = null; }, durationMs);
	}

	// ── Refs (using variables) ──
	let messagesEndEl: HTMLElement;
	let dragHandleEl: HTMLElement;
	let isDragging = false;
	let startTimeMs: number | null = null;
	let timerInterval: ReturnType<typeof setInterval> | null = null;
	let warningSent = false;
	let sessionExpired = false;
	let pendingTtsWarning: string | null = null;
	let pendingAutoEnd = false;

	// ── Speech Recognition state ──
	let recognition: any = null;
	let silenceTimer: ReturnType<typeof setTimeout> | null = null;
	let finalTranscriptBuf = '';
	let isActive = false;
	let shouldRestart = false;
	// ── End-of-turn detection ──
	// Silence duration alone is a poor signal for "finished speaking": "Anthropic" is a
	// complete answer in one word, while "so the tricky part was" is unfinished no matter
	// how long the pause. A minimum word count was worse — it trapped short answers
	// entirely, since recognition never stopped and the turn could never be sent.
	// Instead: judge whether the utterance SOUNDS finished, and back it with timeouts.
	const SILENCE_TIMEOUT_MS = 1800;   // sounds complete → send
	const UNFINISHED_TIMEOUT_MS = 4000; // sounds mid-sentence → send anyway rather than stall
	const IDLE_CHECKIN_MS = 6000;      // nothing said at all → ask if they're still there
	const MAX_CHECKINS_PER_TURN = 2;

	// ── Idle close (decided 2026-09-07, timings confirmed 2026-09-08) ──
	// 3 minutes with nothing from the user → the coach speaks IDLE_LINE and a card
	// appears. The mic stays live: any speech dismisses the card and is a normal turn.
	// 10 seconds after the line finishes with no response → the sitting ends through
	// the normal finalize path and lands on the summary. Deferred while the coach is
	// speaking or thinking. 3 minutes (not 4) keeps a returning user inside the
	// prompt-cache TTL.
	const IDLE_PROMPT_MS = 3 * 60 * 1000;
	const IDLE_CLOSE_MS = 10 * 1000;
	const IDLE_LINE = "Still with me? Take your time if you're thinking — or if now's not a good moment, we can wrap this sitting and pick it up later.";
	let lastUserActivity = 0;
	let idleCard = false;
	let idleWatch: ReturnType<typeof setInterval> | null = null;
	let idleCloseTimer: ReturnType<typeof setTimeout> | null = null;

	function touchActivity() {
		lastUserActivity = Date.now();
		if (idleCard) dismissIdleCard();
	}
	function dismissIdleCard() {
		idleCard = false;
		if (idleCloseTimer) { clearTimeout(idleCloseTimer); idleCloseTimer = null; }
	}
	function handleStillHere() {
		touchActivity();
		if (!isSpeaking && !loading && !isListening && phase === 'coaching') startListening();
	}
	function startIdleWatch() {
		stopIdleWatch();
		lastUserActivity = Date.now();
		idleWatch = setInterval(() => {
			if (phase !== 'coaching' || sessionEnded || sessionExpired) return;
			if (isSpeaking || loading) return;               // defer while the coach is busy
			if (!idleCard) {
				if (Date.now() - lastUserActivity >= IDLE_PROMPT_MS) {
					idleCard = true;
					ttsSpeak(IDLE_LINE);                          // mic restarts when TTS ends
				}
			} else if (!idleCloseTimer) {
				// The line has finished (isSpeaking is false) — the 10s window starts now.
				idleCloseTimer = setTimeout(() => {
					if (!idleCard || sessionEnded) return;
					dismissIdleCard();
					handleEnd(true);
				}, IDLE_CLOSE_MS);
			}
		}, 1000);
	}
	function stopIdleWatch() {
		if (idleWatch) { clearInterval(idleWatch); idleWatch = null; }
		dismissIdleCard();
	}

	// Trailing words that almost certainly mean the speaker is still going: hesitations,
	// coordinating conjunctions, and articles/determiners.
	//
	// Deliberately EXCLUDES prepositions and auxiliaries, even though they look like
	// obvious continuations. English strands them at the end of perfectly complete
	// utterances, and this app invites exactly those phrasings: "a project I'm proud
	// OF", "someone I worked WITH", "the thing I was responsible FOR", "yes I WAS".
	// Including them delayed common answers by the full backstop. Also excludes
	// pronouns — "I did IT", "I like THIS" are complete sentences.
	//
	// The cost of a miss is small and self-correcting: a genuine fragment like "I
	// worked at" sends early, the coach asks "at where?", and the conversation
	// recovers naturally. Delaying every "proud of" was the worse trade.
	const HANGING_WORDS = new Set([
		// hesitations / discourse fillers
		'hmm', 'hm', 'um', 'uh', 'er', 'ah', 'eh', 'well', 'like', 'so', 'then',
		// coordinating conjunctions
		'and', 'but', 'or', 'because', 'cause',
		// articles / determiners
		'the', 'a', 'an', 'my', 'our', 'your', 'their', 'his', 'her', 'its',
	]);

	function soundsUnfinished(text: string): boolean {
		const words = text.trim().toLowerCase().split(/\s+/).filter(Boolean);
		if (words.length === 0) return true;
		const last = words[words.length - 1].replace(/[^a-z']/g, '');
		return HANGING_WORDS.has(last);
	}

	let unfinishedTimer: ReturnType<typeof setTimeout> | null = null;
	let idleTimer: ReturnType<typeof setTimeout> | null = null;
	let checkinCount = 0;

	// ── TTS state ──
	let ttsAudio: HTMLAudioElement | null = null;
	let sentenceQueue: string[] = [];
	let isProcessingQueue = false;
	let ttsFlush = false;
	let ttsStarted = false;
	let ttsStopped = false;
	let ttsRevealedText = ''; // text revealed in sync with TTS playback
	let ttsFullText = ''; // full final text (set on stream done)

	// (Filler phrases removed — call view "Thinking..." status is sufficient feedback)

	// ── Helpers ──
	function stripMarkdown(text: string): string {
		return text
			.replace(/\*\*\*(.+?)\*\*\*/g, '$1')
			.replace(/\*\*(.+?)\*\*/g, '$1')
			.replace(/\*(.+?)\*/g, '$1')
			.replace(/__(.+?)__/g, '$1')
			.replace(/_(.+?)_/g, '$1')
			.replace(/^#{1,6}\s+/gm, '')
			.replace(/^[\s]*[-*+•]\s+/gm, '')
			.replace(/^[\s]*\d+\.\s+/gm, '')
			.replace(/```[\s\S]*?```/g, '')
			.replace(/`(.+?)`/g, '$1')
			.replace(/\[(.+?)\]\(.+?\)/g, '$1')
			.replace(/^>\s+/gm, '')
			.replace(/~~/g, '')
			.replace(/\n{3,}/g, '\n\n')
			.trim();
	}

	// ── Speech Recognition ──
	function clearSilenceTimer() {
		if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
		if (unfinishedTimer) { clearTimeout(unfinishedTimer); unfinishedTimer = null; }
		if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
	}

	// End the turn: stop recognition, which fires onend → finalizeTurn.
	function endTurn() {
		clearSilenceTimer();
		shouldRestart = true;
		try { recognition?.stop(); } catch {}
	}

	function finalizeTurn() {
		clearSilenceTimer();
		const transcript = finalTranscriptBuf.trim();
		finalTranscriptBuf = '';
		interimTranscript = '';
		// Send whatever was said. The old version pushed anything under 3 words back
		// into the buffer, which meant a one-word answer could never be submitted.
		if (transcript) {
			checkinCount = 0;
			touchActivity();
			sendMessage(transcript);
		}
	}

	// Spoken nudge when the user has gone quiet without saying anything. Deliberately
	// NOT a conversation turn — no Claude call, nothing added to the transcript, so the
	// extractor and summary never see it. Just a canned line through the existing TTS.
	function speakCheckIn() {
		if (checkinCount >= MAX_CHECKINS_PER_TURN) return;
		if (isSpeaking || loading || sessionExpired) return;
		checkinCount++;
		// Two quick nudges, then quiet until the 3-minute idle prompt takes over. The
		// old second line ("I'll be here until our time is up") promised something the
		// idle close makes untrue.
		ttsSpeak('Still with me?');
	}

	function startSilenceTimer() {
		clearSilenceTimer();
		silenceTimer = setTimeout(() => {
			const buf = finalTranscriptBuf.trim();
			if (buf && !soundsUnfinished(buf)) {
				endTurn(); // sounds complete — send now, however short
				return;
			}
			if (buf) {
				// Mid-sentence pause. Wait a bit longer, then send anyway rather than
				// stall — a wrong guess costs one rough turn; stalling costs the session.
				unfinishedTimer = setTimeout(endTurn, UNFINISHED_TIMEOUT_MS - SILENCE_TIMEOUT_MS);
			} else if (checkinCount < MAX_CHECKINS_PER_TURN) {
				// Nothing said at all — check in instead of sending an empty turn.
				// After the cap, go quiet; the 3-minute idle watch (startIdleWatch)
				// handles a genuinely absent user, and nothing is lost since the
				// story is resumable.
				// No re-arm here: speaking the check-in stops recognition, and the
				// restart afterwards calls startListening(), which arms the timer again.
				idleTimer = setTimeout(speakCheckIn, IDLE_CHECKIN_MS - SILENCE_TIMEOUT_MS);
			}
		}, SILENCE_TIMEOUT_MS);
	}

	function createRecognition() {
		const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
		if (!SR) return null;
		const rec = new SR();
		rec.continuous = true;
		rec.interimResults = true;
		rec.lang = 'en-US';
		rec.maxAlternatives = 1;

		rec.onstart = () => { isListening = true; };

		rec.onresult = (event: any) => {
			let interim = '';
			let final = '';
			for (let i = event.resultIndex; i < event.results.length; i++) {
				if (event.results[i].isFinal) {
					final += event.results[i][0].transcript;
				} else {
					interim += event.results[i][0].transcript;
				}
			}
			if (final || interim) touchActivity();
			if (final) { finalTranscriptBuf += final; startSilenceTimer(); }
			if (interim) { clearSilenceTimer(); }
			const display = finalTranscriptBuf + interim;
			interimTranscript = display;
		};

		rec.onerror = (event: any) => {
			if (event.error === 'no-speech' || event.error === 'aborted') {
				// Benign — mic works and nothing was said, or this is our own restart.
				if (isActive && phase === 'coaching') {
					setTimeout(() => { try { recognition?.start(); } catch {} }, 100);
				}
				return;
			}
			// Everything else was previously discarded here: 'not-allowed' (permission
			// denied), 'audio-capture' (no mic), 'network' (STT unreachable). Keep the
			// most recent one — a session usually fails the same way repeatedly, and the
			// last code is the one that ended it.
			sttError = event.error || 'unknown';
			console.warn('[stt-error]', sttError);
			isListening = false;
		};

		// Speech reached the browser but produced no transcript — a silent failure that
		// raises no error at all, so the codes above would miss it entirely. Paired with
		// a zero-turn session this is strong evidence of STT dropping audio rather than
		// the user being absent.
		rec.onspeechstart = () => { sawSpeech = true; };

		rec.onend = () => {
			isListening = false;
			clearSilenceTimer();
			if (shouldRestart) {
				shouldRestart = false;
				finalizeTurn();
				if (isActive && phase === 'coaching') {
					setTimeout(() => { try { recognition?.start(); } catch {} }, 200);
				}
				return;
			}
			if (finalTranscriptBuf.trim()) { finalizeTurn(); }
			if (isActive && phase === 'coaching') {
				setTimeout(() => { try { recognition?.start(); } catch {} }, 200);
			}
		};

		return rec;
	}

	function startListening() {
		isActive = true;
		finalTranscriptBuf = '';
		interimTranscript = '';
		if (recognition) { try { recognition.abort(); } catch {} }
		recognition = createRecognition();
		if (recognition) { try { recognition.start(); } catch {} }
		// Arm the timer NOW, not only when speech arrives. Previously it was started
		// solely from onresult, so a user who said nothing at all never triggered
		// anything — the idle check-in was unreachable in exactly the case it exists
		// for. Silence from the very start is the situation that needs a nudge most.
		startSilenceTimer();
	}

	function stopListening() {
		isActive = false;
		shouldRestart = false;
		clearSilenceTimer();
		if (recognition) { try { recognition.abort(); } catch {} recognition = null; }
		isListening = false;
		if (finalTranscriptBuf.trim()) { finalizeTurn(); }
	}

	// ── TTS (via /storybuilder/api/tts) ──
	let prefetchCache = new Map<string, Promise<Blob | null>>();

	function ttsFetchAudio(text: string): Promise<Blob | null> {
		if (prefetchCache.has(text)) return prefetchCache.get(text)!;
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 8000); // 8s timeout
		const promise = fetch('/storybuilder/api/tts', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ text, sessionId }),
			signal: controller.signal,
		}).then(res => { clearTimeout(timeout); return res.ok ? res.blob() : null; })
		  .catch(() => { clearTimeout(timeout); return null; });
		prefetchCache.set(text, promise);
		return promise;
	}

	async function ttsPlaySentence(text: string): Promise<void> {
		if (ttsStopped || !text.trim()) return;
		try {
			const blob = await ttsFetchAudio(text);
			prefetchCache.delete(text);
			if (!blob || ttsStopped) {
				console.warn('[TTS] skip:', !blob ? 'no blob' : 'stopped', text.slice(0, 30));
				return;
			}
			console.log('[TTS] playing:', text.slice(0, 40), 'size:', blob.size);
			const url = URL.createObjectURL(blob);
			return new Promise<void>((resolve) => {
				const audio = new Audio(url);
				ttsAudio = audio;
				let resolved = false;
				let safetyTimeout: ReturnType<typeof setTimeout>;
				const playStartTime = Date.now();
				const done = (reason: string) => {
					if (resolved) return;
					resolved = true;
					const elapsed = Date.now() - playStartTime;
					console.log(`[TTS] done (${reason}) after ${elapsed}ms:`, text.slice(0, 40));
					clearTimeout(safetyTimeout);
					try { audio.pause(); } catch {}
					URL.revokeObjectURL(url);
					ttsAudio = null;
					resolve();
				};
				audio.onloadedmetadata = () => {
					console.log('[TTS] metadata: duration=', audio.duration, 'readyState=', audio.readyState, text.slice(0, 30));
					// Reset safety timeout using actual duration if available
					if (audio.duration && isFinite(audio.duration)) {
						clearTimeout(safetyTimeout);
						const actualTimeoutMs = audio.duration * 1000 + 3000;
						safetyTimeout = setTimeout(() => {
							console.warn('[TTS] safety timeout (actual duration) — expected', audio.duration, 's, readyState=', audio.readyState, 'paused=', audio.paused, 'ended=', audio.ended);
							done('safety-timeout');
						}, actualTimeoutMs);
					}
				};
				audio.onstalled = () => console.warn('[TTS] stalled:', text.slice(0, 30));
				audio.onsuspend = () => console.log('[TTS] suspend:', text.slice(0, 30));
				audio.onwaiting = () => console.warn('[TTS] waiting:', text.slice(0, 30));
				// Initial safety timeout based on blob size estimate, replaced by actual duration when metadata loads
				const estimatedDurationMs = Math.max(8000, (blob.size / 16000) * 1000 + 4000);
				safetyTimeout = setTimeout(() => {
					console.warn('[TTS] safety timeout (estimated) after', Math.round(estimatedDurationMs / 1000), 's — duration was', audio.duration, 'readyState=', audio.readyState, 'paused=', audio.paused, 'ended=', audio.ended);
					done('safety-timeout');
				}, estimatedDurationMs);
				audio.onended = () => done('ended');
				audio.onerror = () => {
					console.error('[TTS] audio error:', audio.error?.code, audio.error?.message, text.slice(0, 30));
					done('error');
				};
				audio.play().catch((err) => {
					console.error('[TTS] play() rejected:', err.message, text.slice(0, 30));
					done('play-rejected');
				});
			});
		} catch (err) {
			console.warn('[TTS] fetch failed:', err);
		}
	}

	async function ttsProcessQueue() {
		if (isProcessingQueue) return;
		isProcessingQueue = true;
		console.log('[TTS] queue processing start, items:', sentenceQueue.length);
		while (sentenceQueue.length > 0 && !ttsStopped) {
			// Prefetch next sentence while current one plays
			if (sentenceQueue.length > 1) {
				ttsFetchAudio(sentenceQueue[1]);
			}
			const next = sentenceQueue.shift()!;
			// Track what's been spoken so template can dim upcoming text
			ttsRevealedText += (ttsRevealedText ? ' ' : '') + next;
			await ttsPlaySentence(next);
		}
		isProcessingQueue = false;
		console.log('[TTS] queue drained, flush:', ttsFlush, 'stopped:', ttsStopped);
		if (ttsFlush && !ttsStopped) {
			// TTS done — drop streaming flag so dimming stops
			messages = messages.map(m => m.streaming ? { role: 'interviewer', content: m.content } : m);
			isSpeaking = false;
			ttsStarted = false;
			if (pendingAutoEnd) {
				pendingAutoEnd = false;
				handleEnd(true);
				return;
			}
			setTimeout(() => {
				if (phase === 'coaching') startListening();
			}, 300);
		}
	}

	function ttsQueueSentence(sentence: string) {
		if (!sentence.trim() || ttsStopped) return;
		if (!ttsStarted) {
			ttsStarted = true;
			isSpeaking = true;
			stopListening();
		}
		sentenceQueue.push(sentence);
		// Start prefetching immediately so audio is ready when it's time to play
		ttsFetchAudio(sentence);
		ttsProcessQueue();
	}

	function ttsFlushQueue() {
		ttsFlush = true;
		if (sentenceQueue.length === 0 && !isProcessingQueue) {
			// Drop streaming flag so dimming stops
			messages = messages.map(m => m.streaming ? { role: 'interviewer', content: m.content } : m);
			if (ttsStarted) {
				isSpeaking = false;
				ttsStarted = false;
				if (pendingAutoEnd) {
					pendingAutoEnd = false;
					handleEnd(true);
					return;
				}
				setTimeout(() => {
					if (phase === 'coaching') startListening();
				}, 300);
			}
		}
	}

	function ttsStartStreaming() {
		// Stop any audio still playing from the previous turn
		if (ttsAudio) {
			try { ttsAudio.pause(); } catch {}
			ttsAudio = null;
		}
		ttsStopped = false;
		ttsFlush = false;
		ttsStarted = false;
		sentenceQueue = [];
		isProcessingQueue = false;
		ttsRevealedText = '';
		ttsFullText = '';
		prefetchCache.clear();
	}

	function ttsSpeak(text: string) {
		if (!text) return;
		ttsStop();
		ttsStopped = false;
		ttsFlush = true;
		ttsStarted = true;
		isSpeaking = true;
		ttsRevealedText = '';
		ttsFullText = text;
		stopListening();
		// Split into sentences using string scan (same break points as streaming)
		const breaks = ['. ', '? ', '! ', '.\n', '?\n', '!\n', '."', '?"', '!"', '”', '?”', '!”', '\n'];
		let remaining = text;
		while (remaining.length > 0) {
			let earliest = -1;
			let breakLen = 0;
			for (const br of breaks) {
				const idx = remaining.indexOf(br);
				if (idx !== -1 && (earliest === -1 || idx < earliest)) {
					earliest = idx;
					breakLen = br.length;
				}
			}
			if (earliest === -1) {
				// No more break points — queue the rest
				if (remaining.trim().length > 3) {
					sentenceQueue.push(remaining.trim());
					ttsFetchAudio(remaining.trim()); // prefetch
				}
				break;
			}
			const chunk = remaining.slice(0, earliest + breakLen).trim();
			if (chunk.length > 3) {
				sentenceQueue.push(chunk);
				ttsFetchAudio(chunk); // prefetch all chunks immediately
			}
			remaining = remaining.slice(earliest + breakLen);
		}
		ttsProcessQueue();
	}

	function ttsStop() {
		ttsStopped = true;
		sentenceQueue = [];
		isProcessingQueue = false;
		ttsFlush = false;
		if (ttsAudio) {
			ttsAudio.pause();
			ttsAudio = null;
		}
		prefetchCache.clear();
		isSpeaking = false;
		ttsStarted = false;
		// Drop streaming flag so dimming stops
		messages = messages.map(m => m.streaming ? { role: 'interviewer', content: m.content } : m);
	}

	// ── Send message (streaming SSE) ──
	async function sendMessage(userMessage: string) {
		if (!userMessage.trim() || loading || sessionExpired) return;

		messages = [...messages, { role: 'candidate', content: userMessage }];
		loading = true;

		// Add streaming placeholder
		messages = [...messages, { role: 'interviewer', content: '', streaming: true }];

		try {
			const res = await fetch('/storybuilder/api/respond', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ sessionId, message: userMessage }),
			});

			if (!res.ok) {
				const errData = await res.json();
				messages = messages.filter(m => !m.streaming).concat([
					{ role: 'system', content: `Error: ${errData.error}` }
				]);
				loading = false;
				return;
			}

			const reader = res.body!.getReader();
			const decoder = new TextDecoder();
			let buffer = '';
			let streamedText = '';
			let spokenText = '';
			let finalData: any = null;

			ttsStartStreaming();

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split('\n');
				buffer = lines.pop() || '';
				for (const line of lines) {
					if (!line.startsWith('data: ')) continue;
					try {
						const event = JSON.parse(line.slice(6));
						if (event.type === 'chunk') {
							streamedText += event.text;
							const clean = stripMarkdown(streamedText);
							messages = messages.map(m => m.streaming ? { ...m, content: clean } : m);
							if (loading) { loading = false; stopListening(); isSpeaking = true; }

							// TTS chunking: split streamed text into sentences for TTS
							const cleanSoFar = stripMarkdown(streamedText);
							let unspoken = cleanSoFar.slice(spokenText.length);
							const isFirstChunk = spokenText.length === 0 || !ttsStarted;
							const eagerBreaks = [', ', '; ', ': ', ',\n', ';\n', ':\n'];
							const sentenceBreaks = ['. ', '? ', '! ', '.\n', '?\n', '!\n', '.”', '?”', '!”', '”', '?”', '!”', '\n'];
							const breaks = isFirstChunk && unspoken.length >= 15 ? [...sentenceBreaks, ...eagerBreaks] : sentenceBreaks;
							let consumed = 0;
							let remaining = unspoken;
							while (remaining.length > 0) {
								let earliest = -1;
								let breakLen = 0;
								for (const br of breaks) {
									const idx = remaining.indexOf(br);
									if (idx !== -1 && (earliest === -1 || idx < earliest)) {
										if (eagerBreaks.includes(br) && idx < 14) continue;
										earliest = idx;
										breakLen = br.length;
									}
								}
								if (earliest === -1) break;
								const chunk = remaining.slice(0, earliest + breakLen).trim();
								if (chunk.length > 5) ttsQueueSentence(chunk);
								consumed += earliest + breakLen;
								remaining = remaining.slice(earliest + breakLen);
								if (isFirstChunk && consumed > 0) break;
							}
							if (consumed > 0) {
								spokenText = cleanSoFar.slice(0, spokenText.length + consumed);
							}
						} else if (event.type === 'done') {
							finalData = event;
							// Process remaining text for TTS immediately — don't wait for stream close
							const cleanMessage = stripMarkdown(event.message);
							ttsFullText = cleanMessage;
							messages = messages.map(m => m.streaming ? { ...m, content: cleanMessage } : m);
							const remaining = cleanMessage.slice(spokenText.length).trim();
							console.log('[TTS] done event — remaining text:', remaining.length, 'chars, queue:', sentenceQueue.length, 'processing:', isProcessingQueue);
							if (remaining.length > 5) {
								const sentBreaks = ['. ', '? ', '! ', '.\n', '?\n', '!\n', '."', '?"', '!"'];
								let rest = remaining;
								const pendingSentences: string[] = [];
								while (rest.length > 0) {
									let earliest = -1;
									let bLen = 0;
									for (const br of sentBreaks) {
										const idx = rest.indexOf(br);
										if (idx !== -1 && (earliest === -1 || idx < earliest)) { earliest = idx; bLen = br.length; }
									}
									if (earliest === -1) {
										if (rest.trim().length > 3) pendingSentences.push(rest.trim());
										break;
									}
									const chunk = rest.slice(0, earliest + bLen).trim();
									if (chunk.length > 3) pendingSentences.push(chunk);
									rest = rest.slice(earliest + bLen);
								}
								console.log('[TTS] prefetching', pendingSentences.length, 'remaining sentences');
								pendingSentences.forEach(s => ttsFetchAudio(s));
								pendingSentences.forEach(s => ttsQueueSentence(s));
							}
							if (pendingTtsWarning) {
								ttsQueueSentence(pendingTtsWarning);
								pendingTtsWarning = null;
							}
							ttsFlushQueue();
						} else if (event.type === 'star_update') {
							// Real-time STAR section updates from parallel extractor
							if (event.question) extractedQuestion = event.question;
							if (event.flags) extractedFlags = event.flags;
							if (event.status) starStatus = { ...starStatus, ...event.status };
							for (const update of event.updates) {
								starSections = { ...starSections, [update.section]: update.content };
							}
						} else if (event.type === 'superseded') {
							handleSuperseded();
						} else if (event.type === 'error') {
							messages = messages.filter(m => !m.streaming).concat([
								{ role: 'system', content: `Error: ${event.error}` }
							]);
						}
					} catch {}
				}
			}

			// After stream closes, handle session-ending if needed
			if (finalData?.done) {
				stopListening();
				if (finalData.reason === 'off_topic' || finalData.reason === 'switch') {
					// The coach's closing line is the explanation — let it be heard,
					// then end. (The 20-min path stops TTS because the client already
					// spoke its own time-up line.)
					sessionExpired = true;
					if (isSpeaking) pendingAutoEnd = true; else await handleEnd(true);
				} else {
					ttsStop();
					await handleEnd(true);
				}
			}
		} catch {
			messages = messages.filter(m => !m.streaming).concat([
				{ role: 'system', content: 'Error communicating with server.' }
			]);
		}
		loading = false;

		// If session expired while this exchange was in progress, end after TTS finishes
		if (sessionExpired && !loading) {
			if (isSpeaking) {
				// TTS still playing (includes the time-up message) — let it finish
				pendingAutoEnd = true;
			} else {
				await handleEnd(true);
			}
		}
	}

	// ── Start session ──
	async function handleStart(takeover = false) {
		loading = true;
		lockConflict = false;
		try {
			// The start endpoint now handles the credit deduction atomically and
			// server-side (subscribers are skipped). A session is only created if the
			// deduction committed, so there's no client-side deduct/refund dance.
			const startBody = (takeover: boolean) => JSON.stringify(
				resumeStoryId ? { storyId: resumeStoryId, takeover } : {}
			);
			const interviewRes = await fetch('/storybuilder/api/start', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: startBody(takeover),
			});

			// Held by another live tab. The lobby shows a card offering takeover.
			if (interviewRes.status === 409) {
				lockConflict = true;
				loading = false;
				return;
			}

			if (!interviewRes.ok) {
				let errCode = '';
				try { errCode = (await interviewRes.json()).error; } catch {}
				if (interviewRes.status === 404 || errCode === 'story_not_found') {
					showToast("We couldn't find that story. Starting fresh instead.", 'error', 8000);
					resumeStoryId = null;
					setStoryInUrl(null);
				} else if (errCode === 'story_expired') {
					// Window closed past the grace hour — the lobby shows the $6 reopen.
					if (resumeStory) resumeStory = { ...resumeStory, expired: true };
				} else if (errCode === 'no_stories' || errCode === 'window_ended' || errCode === 'no_purchase') {
					blockedReason = errCode;
				} else if (interviewRes.status === 402 || errCode === 'no_credits') {
					blockedReason = 'no_purchase';
				} else if (interviewRes.status === 503 || errCode === 'billing_unavailable') {
					showToast("We couldn't verify your plan just now — no credit was used. Please try again.", 'error', 8000);
				} else {
					showToast('Something went wrong starting your session — no credit was used. Please try again.', 'error', 8000);
				}
				loading = false;
				return;
			}

			const data = await interviewRes.json();
			// Server returns the new balance (null for subscribers).
			if (data.credits !== undefined && data.credits !== null) {
				$userStore = { ...$userStore, credits: data.credits };
			}
			sessionId = data.sessionId;
			storyId = data.storyId ?? null;
			storyStatus = data.storyStatus ?? 'in_progress';
			setStoryInUrl(storyId);
			startTimeMs = Date.now();
			remainingTime = 20 * 60 * 1000;
			// Resumed: fill the sidebar from stored state before the first turn.
			starSections = { situation: null, task: null, action: null, result: null, ...(data.starSections ?? {}) } as Record<string, string | null>;
			starStatus = { situation: null, task: null, action: null, result: null, ...(data.starStatus ?? {}) };
			extractedQuestion = data.question ?? null;
			sessionEnded = false;
			savedStoryId = null;
			userConfirmedEnd = false;
			superseded = false;
			startHeartbeat();
			startIdleWatch();
			const cleanOpening = stripMarkdown(data.message);
			messages = [{ role: 'interviewer', content: cleanOpening }];
			phase = 'coaching';

			// Start timer
			warningSent = false;
			timerInterval = setInterval(() => {
				if (!startTimeMs) return;
				const elapsed = Date.now() - startTimeMs;
				remainingTime = Math.max(0, 20 * 60 * 1000 - elapsed);
				// 20-minute mark — gracefully end after TTS completes
				if (remainingTime === 0 && timerInterval) {
					clearInterval(timerInterval);
					sessionExpired = true;
					stopListening();

					const timeUpMsg = "Alright, that's our 20 minutes! Let me save everything we worked on.";
					messages = [...messages, { role: 'interviewer', content: timeUpMsg }];

					if (loading) {
						// Coach is mid-stream — append time-up to TTS after response finishes
						pendingTtsWarning = timeUpMsg;
						// sendMessage's sessionExpired check will set pendingAutoEnd
					} else if (isSpeaking) {
						// Coach TTS is still playing — queue time-up at the end
						ttsQueueSentence(timeUpMsg);
						pendingAutoEnd = true;
					} else {
						// Idle — speak time-up then end
						ttsSpeak(timeUpMsg);
						pendingAutoEnd = true;
					}
				}
			}, 1000);

			ttsSpeak(cleanOpening);
		} catch {
			// Network error before we received a response — the server may or may not
			// have started (and charged). Don't falsely claim "no credit used".
			showToast('Something went wrong starting your session. Please refresh and check your credits before retrying.', 'error', 8000);
		}
		loading = false;
	}

	// ── Send text input ──
	// ── Auto-save story to Supabase ──
	let savedStoryId: string | null = null;
	let sessionEnded = false;
	let retryCount = 0;

	// Inline support form (for too_short cases)
	let showSupportForm = false;
	let supportDescription = '';
	let supportSubmitting = false;
	let supportSubmitted = false;

	async function submitSupportRequest() {
		if (!supportDescription.trim()) return;
		supportSubmitting = true;
		try {
			const res = await fetch('/dashboard/api/support', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					topic: 'credit_refund',
					sessionId: sessionId || null,
					description: supportDescription.trim(),
				}),
			});
			const result = await res.json();
			if (result.success) supportSubmitted = true;
		} catch (err) {
			console.error('Support request failed:', err);
		} finally {
			supportSubmitting = false;
		}
	}

	function trySaveStory() {
		if (assessmentLoading) return;
		if (savedStoryId) return; // Already saved
		if (!assessment || assessment.tier === 'empty') return; // Nothing worth saving

		fetch('/storybuilder/api/save', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				session_id: sessionId || null,
				question: assessment.question || null,
				full_story: assessment.fullStory || null,
				talking_points: assessment.sections || null,
				strength_signals: (assessment.strengths?.length || assessment.growth?.length)
					? { strengths: assessment.strengths, growth: assessment.growth }
					: null,
				flags: extractedFlags || null,
				tier: assessment.tier,
			}),
		}).then(res => res.json()).then(data => {
			if (data.saved) {
				savedStoryId = data.id;
				if (data.status === 'complete' || data.status === 'in_progress') storyStatus = data.status;
				// Refresh cached Dashboard/Story Bank data so the new story shows
				// up without a hard refresh.
				invalidate('app:stories');
			}
		}).catch(err => console.warn('Failed to save story:', err));
	}

	// ── End session ──
	async function handleEnd(auto = false) {
		if (!auto) {
			// Subscribers aren't charged per session — don't mention credits to them.
			if (!confirm('Finish this sitting? You can come back to this story any time.')) return;
		}

		userConfirmedEnd = true;
		sessionEnded = true;
		stopHeartbeat();
		stopIdleWatch();
		stopListening();
		ttsStop();
		if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }

		// Show the assembling state while we finalize.
		phase = 'loading-report';

		// Final extraction pass over the full transcript — ensures the sidebar reflects
		// the user's last messages before we decide how to build the summary.
		try {
			const finalizeRes = await fetch('/storybuilder/api/finalize', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ sessionId })
			});
			if (finalizeRes.ok) {
				const { sections } = await finalizeRes.json();
				if (sections) {
					if (sections.question) extractedQuestion = sections.question;
					if (sections.flags) extractedFlags = sections.flags;
					if (sections.status) starStatus = { ...starStatus, ...sections.status };
					starSections = {
						situation: sections.situation ?? null,
						task: sections.task ?? null,
						action: sections.action ?? null,
						result: sections.result ?? null
					};
				}
			}
		} catch { /* non-fatal — fall back to last in-session state */ }

		await runAssessment();
	}

	// Single grounded end-of-session assessment — produces the whole summary from
	// what the user actually shared (no fabrication). Used by handleEnd and retry.
	async function runAssessment() {
		phase = 'loading-report';
		assessmentLoading = true;
		const convHistory = messages.filter(m => m.role === 'interviewer' || m.role === 'user').map(m => ({
			role: m.role === 'interviewer' ? 'assistant' : 'user',
			content: m.content,
		}));

		try {
			const res = await fetch('/storybuilder/api/assess', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ sessionId, starSections, starStatus, conversationHistory: convHistory, question: extractedQuestion }),
			});
			const data = await res.json();
			if (data.assessment && !data.assessment.error) {
				assessment = data.assessment;
				report = assessment.tier === 'empty' ? { error: 'insufficient', message: 'Not enough real detail was shared to build a story.' } : null;
			} else {
				report = { error: 'assess_failed' };
			}
		} catch {
			report = { error: 'api_error' };
		}
		assessmentLoading = false;
		phase = 'report';

		// Mark session completed + log cost (fire-and-forget).
		const starSectionsFilled = Object.values(starSections).filter(Boolean).length;
		fetch('/storybuilder/api/end', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ sessionId, generateReport: false, starSectionsFilled, sttError, sawSpeech }),
		}).catch(() => {});

		trySaveStory();
	}

	async function handleRetry() {
		retryCount++;
		await runAssessment();
		if (report?.error && report.error !== 'insufficient') {
			if (retryCount >= 2) logGlitch();
		} else {
			retryCount = 0;
		}
	}

	function logGlitch() {
		const glitchStarFilled = Object.values(starSections).filter(Boolean).length;
		fetch('/storybuilder/api/glitch', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ sessionId, starSectionsFilled: glitchStarFilled }),
		}).catch(err => console.warn('Failed to log glitch:', err));
	}

	// Back into the SAME story: the lobby shows what's being resumed (4.6) and the
	// Start button reads "Continue". Session-level state resets; the story's state
	// comes back from the server on start.
	function handleContinueStory() {
		if (!storyId) return handleBuildAnother();
		resumeStoryId = storyId;
		setStoryInUrl(storyId);
		phase = 'lobby';
		messages = [];
		sessionId = null;
		report = null;
		assessment = null;
		userConfirmedEnd = false;
		sessionExpired = false;
		pendingAutoEnd = false;
		extractedFlags = null;
		ttsStop();
	}

	function handleBuildAnother() {
		phase = 'lobby';
		messages = [];
		sessionId = null;
		storyId = null;
		resumeStoryId = null;
		setStoryInUrl(null);
		sessionExpired = false;
		pendingAutoEnd = false;
		report = null;
		assessment = null;
		userConfirmedEnd = false;
		extractedFlags = null;
		starSections = { situation: null, task: null, action: null, result: null } as Record<string, string | null>;
		starStatus = { situation: null, task: null, action: null, result: null };
		ttsStop();
	}

	function handleInterrupt() {
		if (isSpeaking && !sessionExpired) {
			ttsStop();
			startListening();
		}
	}

	// ── Sidebar drag ──
	function handleMouseDown(e: MouseEvent) {
		e.preventDefault();
		isDragging = true;
		document.body.style.cursor = 'col-resize';
		document.body.style.userSelect = 'none';
		dragHandleEl?.classList.add('dragging');
	}

	function handleMouseMove(e: MouseEvent) {
		if (!isDragging || !browser) return;
		e.preventDefault();
		const vw = window.innerWidth;
		const minW = vw * 0.2;
		const maxW = vw * 0.5;
		sidebarWidth = Math.min(maxW, Math.max(minW, vw - e.clientX));
	}

	function handleMouseUp() {
		if (isDragging) {
			isDragging = false;
			document.body.style.cursor = '';
			document.body.style.userSelect = '';
			dragHandleEl?.classList.remove('dragging');
		}
	}

	// ── Auto-scroll (only after conversation has multiple messages) ──
	$: if ((messages?.length > 1 || interimTranscript) && messagesEndEl) {
		const scrollBehavior = isListening && interimTranscript ? 'instant' : 'smooth';
		setTimeout(() => messagesEndEl?.scrollIntoView({ behavior: scrollBehavior }), 50);
	}

	// ── Timer display ──
	$: timerMinutes = Math.floor(remainingTime / 60000);
	$: timerSeconds = String(Math.floor((remainingTime % 60000) / 1000)).padStart(2, '0');
	$: timerWarning = remainingTime < 2 * 60 * 1000;

	// ── Mic indicator ──
	$: micState = isSpeaking ? 'speaking' : loading ? 'processing' : isListening ? 'listening' : 'idle';
	$: micLabel = isSpeaking ? 'Coach speaking' : loading ? 'Thinking...' : isListening ? 'Listening to you...' : 'Mic idle';

	// ── STAR progress (count of green sections) ──
	$: completedCount = [starStatus.situation, starStatus.task, starStatus.action, starStatus.result].filter(s => s === 'green').length;
	$: partialCount = [starStatus.situation, starStatus.task, starStatus.action, starStatus.result].filter(s => s === 'yellow').length;

	// Summary is a single-column, section-card layout now.
	const SUMMARY_SECTIONS = [
		{ key: 'situation', label: 'Situation' },
		{ key: 'task', label: 'Task' },
		{ key: 'action', label: 'Action' },
		{ key: 'result', label: 'Result' }
	];


	// The abandon beacon is gone (decided 2026-08-19). It never fired on crashes,
	// OS kills, or dead batteries — exactly when it mattered — and everything it
	// decided is now derived server-side: turns persist per turn, and a sitting that
	// died without reporting is marked 'abandoned' when its story is next resumed.
	// Leaving the page mid-session loses nothing; the story is resumable from the
	// Story Bank or the ?story= URL.

	onMount(() => {
		const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
		browserSupported = !!SR;
		window.addEventListener('mousemove', handleMouseMove);
		window.addEventListener('mouseup', handleMouseUp);
		document.addEventListener('visibilitychange', handleVisibility);
		resumeStoryId = new URLSearchParams(window.location.search).get('story');
	});

	onDestroy(() => {
		if (!browser) return;
		stopListening();
		ttsStop();
		ttsStop();
		if (timerInterval) clearInterval(timerInterval);
		window.removeEventListener('mousemove', handleMouseMove);
		window.removeEventListener('mouseup', handleMouseUp);
		document.removeEventListener('visibilitychange', handleVisibility);
		stopHeartbeat();
		stopIdleWatch();
	});
</script>

{#if toast}
	<!-- svelte-ignore a11y-click-events-have-key-events -->
	<!-- svelte-ignore a11y-no-static-element-interactions -->
	<div class="toast toast-{toast.type}" on:click={() => toast = null}>
		<span class="toast-icon">
			{#if toast.type === 'error'}&#9888;&#65039;
			{:else if toast.type === 'success'}&#9989;
			{:else}&#8505;&#65039;
			{/if}
		</span>
		<span class="toast-msg">{toast.message}</span>
		<span class="toast-close">&times;</span>
	</div>
{/if}

{#if !browserSupported}
	<div class="sb-container">
		<div class="sb-lobby">
			<div class="sb-lobby-icon">&#x1F6AB;</div>
			<h1>Browser Not Supported</h1>
			<p>This app requires speech recognition which is not available in your browser.</p>
			<p style="color: #c96442; margin-top: 16px;">
				Please use <strong>Google Chrome</strong>, <strong>Microsoft Edge</strong>, or <strong>Safari</strong>.
			</p>
		</div>
	</div>

{:else if phase === 'lobby'}
	<div class="sb-back-row">
		<a href="/dashboard" class="sb-back-link">&larr; Dashboard</a>
	</div>
	<div class="sb-container">
		<div class="sb-lobby">
			{#if resumeStory?.expired}
				<div class="sb-lobby-icon">&#x23F3;</div>
				<h1>This story's build window has ended</h1>
				<div class="sb-lobby-resume">
					<span class="sb-lobby-resume-label">{resumeStory.status === 'complete' ? 'Complete' : `${resumeStory.green} of 4 sections solid`}</span>
					<p class="sb-lobby-resume-q" class:untitled={!resumeStory.question}>
						{resumeStory.question || 'Question not settled yet'}
					</p>
				</div>
				<p class="sb-lobby-note">
					Everything you built is saved and yours to keep. To keep working on it, reopen it for another 30 days.
				</p>
				<div class="sb-lobby-actions">
					<a href="/credits?finish={resumeStory.id}" class="sb-start-btn sb-overlay-btn">Finish this story for $6</a>
					<a href="/stories" class="sb-start-btn sb-start-btn-secondary sb-overlay-btn">Back to my stories</a>
				</div>
			{:else if blockedReason && !resumeStory}
				<div class="sb-lobby-icon">&#x1F4DA;</div>
				{#if blockedReason === 'no_stories'}
					<h1>You've used every story in your bundle</h1>
					<p class="sb-lobby-note">Nice work. Get another 15 to keep building, or add a single story.</p>
				{:else if blockedReason === 'window_ended'}
					<h1>Your build window has ended</h1>
					<p class="sb-lobby-note">Your stories are yours to keep. To build more, start a new bundle or add a single story.</p>
				{:else}
					<h1>Start your first interview-ready story</h1>
					<p class="sb-lobby-note">Pick a plan and your coach will take it from there.</p>
				{/if}
				<div class="sb-lobby-actions">
					<a href="/credits" class="sb-start-btn sb-overlay-btn">See plans</a>
					<a href="/stories" class="sb-start-btn sb-start-btn-secondary sb-overlay-btn">My Story Bank</a>
				</div>
			{:else if lockConflict}
				<div class="sb-lobby-icon">&#x1F5D7;</div>
				<h2>This story is open in another window</h2>
				<p class="sb-lobby-note">Continue here instead? The other window will stop, and nothing is lost — every turn is saved as you go.</p>
				<div class="sb-lobby-actions">
					<button class="sb-start-btn" on:click={() => handleStart(true)} disabled={loading}>
						{loading ? 'Starting...' : 'Continue here'}
					</button>
					<button class="sb-start-btn sb-start-btn-secondary" on:click={() => (lockConflict = false)}>Never mind</button>
				</div>
			{:else if resumeStory}
				<div class="sb-lobby-icon">&#x1F501;</div>
				<h1>{resumeStory.status === 'complete' ? 'Sharpen your story' : 'Pick up where you left off'}</h1>
				<div class="sb-lobby-resume">
					<span class="sb-lobby-resume-label">{resumeStory.status === 'complete' ? 'Complete' : `${resumeStory.green} of 4 sections solid`}</span>
					<p class="sb-lobby-resume-q" class:untitled={!resumeStory.question}>
						{resumeStory.question || 'Question not settled yet'}
					</p>
				</div>
				<div class="sb-lobby-tips" style="margin-top: 0;">
					<h3>Another focused 20 minutes</h3>
					<p style="color: #555; font-size: 0.9rem; margin-bottom: 0;">
						Your coach remembers everything from before and will {resumeStory.status === 'complete' ? 'follow your lead on what to tighten up' : 'pick up at the next section'}.
						No credit is used to continue a story.
					</p>
				</div>
				{#if windowEndsSoon}
					<p class="sb-lobby-window">Your build window ends {fmtDay(windowEndsSoon)}.</p>
				{/if}
				<div class="sb-lobby-actions">
					<button class="sb-start-btn" on:click={() => handleStart()} disabled={loading}>
						{loading ? 'Starting...' : resumeStory.status === 'complete' ? 'Sharpen this story' : 'Continue story'}
					</button>
					<button class="sb-start-btn sb-start-btn-secondary" on:click={handleBuildAnother}>Start a new story instead</button>
				</div>
			{:else}
				<div class="sb-lobby-icon">&#10024;</div>
				<h1>You are 20 minutes away from <span style="color: #c96442; font-weight: 700;">impressing your interviewer!</span></h1>
				<br>
				<div class="sb-lobby-tips">
					<h3>How it works</h3>
					<ul>
						<li>Tell your coach what type of questions you want to practice. Clarify as needed.</li>
						<li>Share a rough experience from your work. <strong>Feel free to ramble here!</strong></li>
						<li>Your coach will ask insightful questions to extract the key details.</li>
						<li>Together you shape it into a Situation, Task, Action, Result story.</li>
						<li>Walk away with a ready-to-use interview answer, plus talking points.</li>
					</ul>
				</div>
				<div class="sb-lobby-tips" style="margin-top: 0;">
					<h3>Voice Mode for now</h3>
					<p style="color: #555; font-size: 0.9rem; margin-bottom: 0;">
						Your microphone will be used for hands-free conversation.
						The coach speaks, then listens to you automatically.
						You can click on the text wall to interrupt at any time.
					</p>
				</div>
				{#if windowEndsSoon}
					<p class="sb-lobby-window">Your build window ends {fmtDay(windowEndsSoon)}.</p>
				{/if}
				{#if !$userStore.subscriptionID && data?.plan && data.plan.storiesLeft > 0 && data.plan.storiesLeft <= 3}
					<p class="sb-lobby-left">{data.plan.storiesLeft} {data.plan.storiesLeft === 1 ? 'story' : 'stories'} left on your plan</p>
				{:else if !$userStore.subscriptionID && data?.plan?.storiesLeft === 0 && (data?.credits ?? 0) > 0}
					<p class="sb-lobby-left">One credit starts this story.</p>
				{/if}
				<button class="sb-start-btn" on:click={() => handleStart()} disabled={loading}>
					{loading ? 'Starting...' : 'Start Building'}
				</button>
			{/if}
		</div>
	</div>

{:else if phase === 'loading-report'}
	<div class="sb-container">
		<div class="sb-lobby sb-lobby-loading">
			<div class="sb-lobby-icon">&#9997;&#65039;</div>
			<h2>Assembling your story...</h2>
			<p>Putting together your polished answer.</p>
		</div>
	</div>

{:else if phase === 'report'}
	<div class="sb-container">
		<div>
			<!-- Story Report -->
			<div class="sb-scorecard">
				{#if report?.error}
					{#if report.error === 'too_short' || report.error === 'insufficient'}
						<h2>Not enough to build a story</h2>
						<div class="sb-score-section">
							<p style="color: #555;">
								{#if report.message}
									{report.message} A strong STAR story needs a real Situation, Task, the specific Actions you personally took, and a concrete Result.
								{:else if userConfirmedEnd}
									You ended the session before sharing enough details for a complete STAR story. A story needs a fleshed-out Situation, Task, Action, and Result to be useful in interviews.
								{:else}
									The session ended before enough details were shared to build a complete story.
								{/if}
							</p>
						</div>
						<div class="sb-scorecard-actions">
							<a href="/dashboard" class="sb-error-dashboard-link">Back to Dashboard</a>
						</div>

						<!-- Inline support form for credit request -->
						{#if true}
							<div class="sb-support-inline">
								{#if supportSubmitted}
									<div class="sb-support-done">
										<span class="sb-support-done-icon">✓</span>
										<p>Request submitted — we'll review and get back to you within 24 hours.</p>
									</div>
								{:else if showSupportForm}
									<h4>Request credit support</h4>
									<p class="sb-support-hint">Tell us what happened and we'll review your session.</p>
									<textarea class="sb-support-textarea" bind:value={supportDescription} placeholder="e.g. I started the session but the coach wasn't responding to my answers…" rows="3"></textarea>
									<div class="sb-support-btns">
										<button class="sb-support-cancel" on:click={() => showSupportForm = false}>Cancel</button>
										<button class="sb-support-submit" on:click={submitSupportRequest} disabled={!supportDescription.trim() || supportSubmitting}>
											{supportSubmitting ? 'Submitting…' : 'Submit'}
										</button>
									</div>
								{:else}
									<button class="sb-support-trigger" on:click={() => showSupportForm = true}>
										Think you deserve a credit? Request support &rarr;
									</button>
								{/if}
							</div>
						{/if}
					{:else if retryCount < 2}
						<h2>We hit a hiccup</h2>
						<div class="sb-score-section">
							<p style="color: #555;">
								{#if report.error === 'parse_error'}
									Your coaching session is complete, but we couldn't assemble the final polished story. This is usually a one-time glitch — retrying typically fixes it.
								{:else if report.error === 'api_error'}
									Your coaching session is complete, but we lost connection while generating your polished story. Your session data is safe.
								{:else}
									Your coaching session is complete, but something went wrong generating the final story.
								{/if}
							</p>
							{#if retryCount === 1}
								<p style="color: #8E8CA0; font-size: 0.85rem;">Attempt {retryCount} of 2 failed — one more try.</p>
							{/if}
						</div>
						<div class="sb-scorecard-actions">
							<button class="sb-start-btn" on:click={handleRetry}>Re-generate My Story</button>
							<a href="/dashboard" class="sb-error-dashboard-link">Back to Dashboard</a>
						</div>
					{:else}
						<h2>We've saved your session</h2>
						<div class="sb-score-section">
							<p style="color: #555;">
								We tried twice but couldn't generate your polished story right now. Don't worry — your full coaching session is saved on our end. Your story will appear in your Story Bank once we resolve this.
							</p>
							<p class="sb-glitch-notice">We've flagged this session for review.</p>
						</div>
						<div class="sb-scorecard-actions">
							<a href="/dashboard" class="sb-error-dashboard-link" style="font-size: 0.95rem;">Back to Dashboard</a>
						</div>
					{/if}
				{:else if assessment}
					<h2>{assessment.tier === 'complete' ? 'Your STAR story' : 'Your story so far'}</h2>
					{#if assessment.question}
						<div class="sb-score-section">
							<h3>Interview question</h3>
							<p style="color: #2d2d2d; font-style: italic;">{assessment.question}</p>
						</div>
					{/if}
					{#if assessment.tier === 'complete' && assessment.fullStory}
						<div class="sb-score-section">
							<h3>Your polished answer</h3>
							<p style="color: #999; font-size: 0.8rem; margin-bottom: 12px;">~3-5 minutes when spoken at a natural pace</p>
							<div class="sb-full-story">{assessment.fullStory}</div>
						</div>
					{:else}
						<p class="sb-summary-note">You've got real material here, but it's not a complete story yet. Below is what you built and exactly what to add.</p>
					{/if}
					{#each SUMMARY_SECTIONS as s}
						{@const sec = assessment.sections[s.key]}
						<div class="sb-summary-card" class:green={sec.status === 'green'} class:yellow={sec.status === 'yellow'} class:none={!sec.status}>
							<div class="sb-summary-card-head">
								<span class="sb-summary-dot">{sec.status === 'green' ? '✓' : sec.status === 'yellow' ? '◐' : '○'}</span>
								<span class="sb-summary-card-title">{s.label}</span>
							</div>
							{#if sec.talkingPoints && sec.talkingPoints.length > 0}
								<ul class="sb-summary-points">
									{#each sec.talkingPoints as p}<li>{p}</li>{/each}
								</ul>
							{/if}
							{#if sec.strong}<p class="sb-summary-strong">✓ {sec.strong}</p>{/if}
							{#if sec.missing}<p class="sb-summary-missing">↗ {sec.missing}</p>{/if}
						</div>
					{/each}
				{/if}
			</div>
			<!-- Strengths & growth (grounded in what the user actually shared) -->
			{#if !report?.error && assessment}
				<div class="sb-signals-card">
					<h3>Strengths &amp; growth</h3>
					<p class="sb-signals-subtitle">Based only on what you actually shared in this session.</p>
					{#if assessment.strengths.length > 0}
						<div class="sb-signals-group">
							<div class="sb-signals-group-label sb-signals-strong-label">Strengths</div>
							{#each assessment.strengths as item}
								<div class="sb-signal-item sb-signal-strong">
									<span class="sb-signal-icon">✓</span>
									<div>
										<span class="sb-signal-name">{item.signal}</span>
										<span class="sb-signal-explain">{item.evidence}</span>
									</div>
								</div>
							{/each}
						</div>
					{/if}
					{#if assessment.growth.length > 0}
						<div class="sb-signals-group">
							<div class="sb-signals-group-label sb-signals-improve-label">Growth areas</div>
							{#each assessment.growth as item}
								<div class="sb-signal-item sb-signal-improve">
									<span class="sb-signal-icon">⚡</span>
									<div>
										<span class="sb-signal-name">{item.signal}</span>
										<span class="sb-signal-explain">{item.detail}</span>
									</div>
								</div>
							{/each}
						</div>
					{/if}
					{#if assessment.strengths.length === 0 && assessment.growth.length === 0}
						<p class="sb-signals-loading">No signals detected yet — share more specifics to surface your strengths.</p>
					{/if}
				</div>
			{/if}

			<!-- Interview Watch Outs -->
			{#if extractedFlags && extractedFlags.length > 0}
				<div class="sb-flags-card">
					<h3>Watch Out</h3>
					<p class="sb-flags-subtitle">Things to avoid saying in the real interview — based on patterns from your coaching session.</p>
					{#each extractedFlags as item}
						<div class="sb-flag-item">
							<span class="sb-flag-icon">⚠</span>
							<div>
								<span class="sb-flag-text">{item.flag}</span>
								<span class="sb-flag-suggestion">{item.suggestion}</span>
							</div>
						</div>
					{/each}
				</div>
			{/if}

			{#if !report?.error && assessment}
				<div class="sb-scorecard-actions">
					{#if storyId}
						<button class="sb-start-btn" on:click={handleContinueStory}>
							{storyStatus === 'complete' ? 'Sharpen this story' : 'Continue this story'}
						</button>
						<button class="sb-start-btn sb-start-btn-secondary" on:click={handleBuildAnother}>Start a new story</button>
					{:else}
						<button class="sb-start-btn" on:click={handleBuildAnother}>Build another story</button>
					{/if}
					<a href="/stories" class="sb-error-dashboard-link">My Story Bank</a>
				</div>
			{/if}
		</div>
	</div>

{:else if phase === 'coaching'}
	<!-- Coaching two-column layout -->
	<div class="sb-coaching-layout">
		<div class="sb-coaching-main">
			<!-- ══════ CALL VIEW ══════ -->
				<div class="sb-call-view">
					{#if idleCard && !superseded}
						<div class="sb-idle-card" role="status">
							<p>Still there? This sitting will wrap up on its own in a moment — your progress is saved either way.</p>
							<button class="sb-start-btn" on:click={handleStillHere}>I'm still here</button>
						</div>
					{/if}
					{#if superseded}
						<div class="sb-overlay-card" role="status">
							<h3>This story is open in another window</h3>
							<p>This session ended here so the two don't talk over each other. Everything you said is saved.</p>
							<a href="/stories" class="sb-start-btn sb-overlay-btn">Back to my stories</a>
						</div>
					{/if}
					<!-- Call status area -->
					<!-- svelte-ignore a11y-click-events-have-key-events -->
					<!-- svelte-ignore a11y-no-static-element-interactions -->
					<div class="sb-call-stage" on:click={isSpeaking && !sessionExpired ? handleInterrupt : undefined}>
						<div class="sb-call-avatar" class:speaking={isSpeaking} class:listening={isListening} class:thinking={loading && !isSpeaking}>
							<span class="sb-call-avatar-icon">&#10024;</span>
							<div class="sb-call-avatar-ring"></div>
						</div>
						<div class="sb-call-status">
							{#if isSpeaking}
								Coach is speaking...
							{:else if loading}
								Thinking...
							{:else if isListening}
								Listening to you...
							{:else}
								Ready
							{/if}
						</div>
						{#if isSpeaking && !sessionExpired}
							<button class="sb-call-interrupt" on:click|stopPropagation={handleInterrupt}>
								Tap to interrupt
							</button>
						{/if}
						{#if isListening && interimTranscript}
							<div class="sb-call-interim">"{interimTranscript}"</div>
						{/if}
					</div>

					<!-- Transcript (collapsible) -->
					{#if showTranscript}
						<div class="sb-transcript-panel">
							<div class="sb-transcript-messages">
								{#each messages as msg}
									<div class="sb-transcript-msg {msg.role}">
										<span class="sb-transcript-label">{msg.role === 'interviewer' ? 'Coach' : 'You'}:</span>
										{#if msg.streaming && ttsRevealedText && msg.content}
											<span class="tts-spoken">{ttsRevealedText}</span><span class="tts-upcoming">{msg.content.slice(ttsRevealedText.length)}</span>
										{:else}
											{msg.content || 'Thinking...'}
										{/if}
									</div>
								{/each}
								{#if loading && !messages.some(m => m.streaming)}
									<div class="sb-transcript-msg interviewer">
										<span class="sb-transcript-label">Coach:</span> Thinking...
									</div>
								{/if}
								<div bind:this={messagesEndEl}></div>
							</div>
						</div>
					{:else}
						<!-- Hidden anchor for scroll tracking -->
						<div bind:this={messagesEndEl} style="display:none"></div>
					{/if}

					<!-- Call controls -->
					<div class="sb-call-controls">
						<button
							class="sb-call-control-btn"
							class:active={isListening}
							on:click={() => isListening ? stopListening() : startListening()}
							disabled={isSpeaking || loading || sessionExpired}
						>
							<span class="sb-call-control-icon">{isListening ? '🔴' : '🎤'}</span>
							<span class="sb-call-control-label">{isListening ? 'Listening' : 'Mic'}</span>
						</button>
						<button
							class="sb-call-control-btn"
							class:active={showTranscript}
							on:click={() => { showTranscript = !showTranscript; if (showTranscript) setTimeout(() => messagesEndEl?.scrollIntoView({ behavior: 'instant' }), 50); }}
						>
							<span class="sb-call-control-icon">📝</span>
							<span class="sb-call-control-label">Transcript</span>
						</button>
						<button
							class="sb-call-control-btn end"
							on:click={() => handleEnd()}
							disabled={loading}
						>
							<span class="sb-call-control-icon">⏹</span>
							<span class="sb-call-control-label">Finish</span>
						</button>
					</div>
				</div>
		</div>

		<!-- Resize handle -->
		<!-- svelte-ignore a11y-no-static-element-interactions -->
		<div
			bind:this={dragHandleEl}
			class="sb-coaching-resize-handle"
			on:mousedown={handleMouseDown}
		></div>

		<!-- STAR sidebar -->
		<div class="sb-coaching-sidebar" style="width: {sidebarWidth}px;">
			<div class="sb-sidebar-top">
				<div class="sb-session-timer" class:warning={timerWarning}>
					{timerMinutes}:{timerSeconds}
				</div>
				<button class="sb-end-btn" on:click={() => handleEnd()} disabled={loading}>Finish</button>
			</div>
			<div class="sb-star-progress-panel">
				<div class="sb-star-progress-header">
					<h3>Your Story in Progress…</h3>
					<span class="sb-star-progress-count">{completedCount}/4</span>
				</div>
				<button class="sb-star-expand-btn" on:click={() => starExpanded = !starExpanded} disabled={completedCount === 0}>
					{starExpanded ? 'Collapse' : 'Expand'}
				</button>
				{#each [{ key: 'situation', label: 'Situation' }, { key: 'task', label: 'Task' }, { key: 'action', label: 'Action' }, { key: 'result', label: 'Result' }] as section}
					<div class="sb-star-progress-section" class:filled={starStatus[section.key] === 'green'} class:partial={starStatus[section.key] === 'yellow'} class:empty={!starStatus[section.key]}>
						<div class="sb-star-progress-label">
							<span class="sb-star-progress-dot">{starStatus[section.key] === 'green' ? '✓' : starStatus[section.key] === 'yellow' ? '◐' : '○'}</span>
							<span>{section.label}</span>
						</div>
						{#if starExpanded && starSections[section.key]}
							<div class="sb-star-progress-content">{starSections[section.key]}</div>
						{/if}
					</div>
				{/each}
				{#if completedCount === 0}
					<p class="sb-star-progress-hint">Sections will be filled here as your coach helps you build each part of your story.</p>
				{/if}
			</div>
		</div>
	</div>
{/if}

<style lang="scss">
	/* ── All styles scoped with sb- prefix to avoid conflicts with global styles ── */

	.sb-container {
		max-width: 960px;
		margin: 0 auto;
		padding: 12px 12px 0;
		min-height: calc(100vh - 50px);
		display: flex;
		flex-direction: column;
	}

	.sb-lobby {
		text-align: center;
		padding: 20px 16px 0;
		display: flex;
		flex-direction: column;
		align-items: center;
	}
	/* Loading state sits alone on the page — clear the sticky header. */
	.sb-lobby-loading { padding-top: 72px; }
	.sb-no-credits {
		text-align: center;
		margin-bottom: auto;
		padding-top: 20vh;
		display: flex;
		flex-direction: column;
		align-items: center;
	}
	.sb-back-row {
		max-width: 1200px;
		margin: 0 auto;
		padding: 68px 20px 0;
	}
	.sb-back-link {
		display: inline-block;
		padding: 10px 24px;
		font-size: 0.9rem;
		font-weight: 600;
		color: #c96442;
		text-decoration: none;
		border: 1px solid #c96442;
		border-radius: 24px;
		transition: all 0.2s;
		&:hover {
			background: #c96442;
			color: white;
		}
	}
	.sb-lobby-icon { font-size: 2.5rem; margin-bottom: 16px; }
	.sb-lobby h1 {
		font-size: 1.75rem;
		font-weight: 600;
		color: #1a1a1a;
		margin-bottom: 8px;
	}
	.sb-lobby h2 {
		font-size: 1.3rem;
		font-weight: 600;
		color: #1a1a1a;
		margin-bottom: 8px;
	}
	.sb-lobby p {
		color: #666;
		max-width: 520px;
		margin-bottom: 28px;
		font-size: 0.95rem;
	}
	.sb-lobby-tips {
		background: #ffffff;
		border: 1px solid #e5e5e3;
		border-radius: 12px;
		padding: 20px 24px;
		text-align: left;
		width: 100%;
		max-width: 640px;
		box-sizing: border-box;
		margin-bottom: 28px;
	}
	.sb-lobby-tips h3 {
		font-size: 0.8rem;
		font-weight: 600;
		color: #b45309;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		margin-bottom: 10px;
		text-align: left;
	}
	.sb-lobby-tips li {
		color: #555;
		font-size: 0.9rem;
		margin-bottom: 4px;
		margin-left: 0px;
		list-style-type: disc;
	}

	.sb-start-btn {
		background: #c96442;
		color: white;
		border: none;
		padding: 12px 36px;
		border-radius: 24px;
		font-size: 1rem;
		font-weight: 500;
		cursor: pointer;
		transition: background 0.2s, transform 0.1s;
		margin-top:0px;
	}
	.sb-start-btn:hover { background: #b5593a; transform: translateY(-1px); }
	.sb-start-btn:active { transform: translateY(0); }
	.sb-start-btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
	.sb-lobby-note { color: #555; font-size: 0.95rem; max-width: 420px; margin: 0 auto 20px; }
	.sb-lobby-window {
		display: inline-block;
		background: #fff6e5;
		color: #8a5a00;
		border-radius: 10px;
		padding: 6px 12px;
		font-size: 0.85rem;
		margin: 0 0 12px;
	}
	.sb-lobby-left { color: #888; font-size: 0.85rem; text-align: center; margin: 0 0 8px; }
	.sb-lobby-actions { display: flex; flex-direction: column; align-items: center; gap: 10px; }
	.sb-lobby-resume {
		background: white;
		border: 1px solid #f3d9c9;
		border-radius: 14px;
		padding: 16px 20px;
		margin: 12px auto 20px;
		max-width: 520px;
		text-align: left;
	}
	.sb-lobby-resume-label {
		display: inline-block;
		font-size: 0.68rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: #9a4a2e;
		background: #fbe7dc;
		border-radius: 10px;
		padding: 2px 8px;
		margin-bottom: 6px;
	}
	.sb-lobby-resume-q { margin: 0; font-weight: 600; color: #2d2d2d; }
	.sb-lobby-resume-q.untitled { font-style: italic; color: #999; font-weight: 400; }
	.sb-overlay-card {
		position: absolute;
		inset: 0;
		z-index: 5;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		text-align: center;
		padding: 32px;
		background: rgba(250, 247, 242, 0.96);
		h3 { margin: 0 0 8px; font-size: 1.15rem; color: #2d2d2d; }
		p { margin: 0 0 18px; color: #555; max-width: 420px; }
	}
	.sb-overlay-btn { text-decoration: none; display: inline-block; }
	.sb-idle-card {
		position: absolute;
		left: 50%;
		bottom: 24px;
		transform: translateX(-50%);
		z-index: 4;
		display: flex;
		align-items: center;
		gap: 16px;
		padding: 14px 18px;
		background: white;
		border: 1px solid #f3d9c9;
		border-radius: 14px;
		box-shadow: 0 8px 24px rgba(0,0,0,0.12);
		max-width: min(560px, calc(100% - 32px));
		p { margin: 0; font-size: 0.9rem; color: #444; }
		.sb-start-btn { padding: 9px 20px; font-size: 0.9rem; white-space: nowrap; }
		@media (max-width: 600px) { flex-direction: column; text-align: center; }
	}
	.sb-start-btn-secondary {
		background: transparent;
		color: #c96442;
		border: 1px solid #c96442;
	}
	.sb-start-btn-secondary:hover { background: #fbe7dc; }

	/* ── Coaching Layout ── */
	.sb-coaching-layout {
		display: flex;
		height: calc(100vh - 56px);
		margin-top: 56px;
		overflow: hidden;
	}
	.sb-coaching-main {
		flex: 1;
		min-width: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		height: 100%;
		overflow: hidden;
		background: #f9f9f8;
	}
	.sb-coaching-sidebar {
		flex-shrink: 0;
		display: flex;
		flex-direction: column;
		height: 100%;
		background: #ffffff;
		overflow: hidden;
	}
	.sb-sidebar-top {
		flex-shrink: 0;
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 16px 24px;
		border-bottom: 1px solid #eee;
	}
	.sb-coaching-resize-handle {
		width: 6px;
		cursor: col-resize;
		background: transparent;
		position: relative;
		flex-shrink: 0;
		z-index: 10;
		transition: background 0.15s;
	}
	.sb-coaching-resize-handle::after {
		content: '';
		position: absolute;
		top: 0;
		bottom: 0;
		left: 2px;
		width: 2px;
		background: #e5e5e3;
		transition: background 0.15s, width 0.15s;
	}
	.sb-coaching-resize-handle:hover::after,
	:global(.sb-coaching-resize-handle.dragging)::after {
		background: #c96442;
		width: 3px;
		left: 1px;
	}
	.sb-coaching-resize-handle:hover,
	:global(.sb-coaching-resize-handle.dragging) {
		background: rgba(201, 100, 66, 0.06);
	}

	/* ── Call View (voice mode) ── */
	.sb-call-view {
		position: relative; /* anchors the superseded overlay card */
		display: flex;
		flex-direction: column;
		height: 100%;
		overflow: hidden;
	}
	.sb-call-stage {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 16px;
		min-height: 200px;
		cursor: default;
		user-select: none;
		background: #f0ebe5;
	}
	.sb-call-avatar {
		position: relative;
		width: 120px;
		height: 120px;
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.sb-call-avatar-icon {
		font-size: 48px;
		z-index: 1;
	}
	.sb-call-avatar-ring {
		position: absolute;
		inset: 0;
		border-radius: 50%;
		border: 3px solid #e0d6ce;
		transition: all 0.3s ease;
	}
	.sb-call-avatar.speaking .sb-call-avatar-ring {
		border-color: #c96442;
		animation: pulse-ring 1.5s ease-in-out infinite;
		box-shadow: 0 0 0 0 rgba(201, 100, 66, 0.3);
	}
	.sb-call-avatar.listening .sb-call-avatar-ring {
		border-color: #16a34a;
		box-shadow: 0 0 12px rgba(22, 163, 74, 0.2);
	}
	.sb-call-avatar.thinking .sb-call-avatar-ring {
		border-color: #d97706;
		animation: pulse-ring-slow 2s ease-in-out infinite;
	}
	@keyframes pulse-ring {
		0%, 100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(201, 100, 66, 0.3); }
		50% { transform: scale(1.08); box-shadow: 0 0 20px 4px rgba(201, 100, 66, 0.15); }
	}
	@keyframes pulse-ring-slow {
		0%, 100% { transform: scale(1); opacity: 0.7; }
		50% { transform: scale(1.04); opacity: 1; }
	}
	.sb-call-status {
		font-size: 1.1rem;
		color: #666;
		font-weight: 500;
	}
	.sb-call-interrupt {
		background: none;
		border: 1px solid #d4c9be;
		color: #999;
		padding: 6px 16px;
		border-radius: 16px;
		font-size: 0.85rem;
		cursor: pointer;
		transition: all 0.2s;
		animation: fade-in 0.8s ease;
	}
	.sb-call-interrupt:hover {
		border-color: #c96442;
		color: #c96442;
	}
	@keyframes fade-in {
		from { opacity: 0; transform: translateY(4px); }
		to { opacity: 1; transform: translateY(0); }
	}
	.sb-call-interim {
		color: #888;
		font-style: italic;
		font-size: 0.95rem;
		max-width: 80%;
		text-align: center;
		line-height: 1.4;
	}

	/* Transcript panel */
	.sb-transcript-panel {
		flex-shrink: 0;
		max-height: 35%;
		border-top: 1px solid #eee;
		overflow: hidden;
		display: flex;
		flex-direction: column;
	}
	.sb-transcript-messages {
		overflow-y: auto;
		padding: 12px 20px;
		font-size: 0.88rem;
		line-height: 1.5;
	}
	.sb-transcript-msg {
		margin-bottom: 8px;
	}
	.sb-transcript-msg.interviewer {
		color: #444;
	}
	.sb-transcript-msg.candidate, .sb-transcript-msg.user {
		color: #777;
	}
	.sb-transcript-label {
		font-weight: 600;
		margin-right: 4px;
	}

	/* Call controls */
	.sb-call-controls {
		flex-shrink: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 24px;
		padding: 0px 8px 20px;
		border-top: 1px solid #e5e5e3;
		background: #f9f9f8;
	}
	.sb-call-control-btn {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 4px;
		margin: 10px;
		background: none;
		border: none;
		cursor: pointer;
		padding: 8px 16px;
		border-radius: 12px;
		transition: background 0.15s;
	}
	.sb-call-control-btn:hover:not(:disabled) {
		background: #f0ebe5;
	}
	.sb-call-control-btn:disabled {
		opacity: 0.3;
		cursor: not-allowed;
	}
	.sb-call-control-btn.active {
		background: #f0ebe5;
	}
	.sb-call-control-btn.end {
		color: #c96442;
	}
	.sb-call-control-icon {
		font-size: 1.5rem;
	}
	.sb-call-control-label {
		font-size: 0.75rem;
		color: #888;
	}

	/* ── Session Controls ── */
	.sb-session-timer {
		font-size: 0.9rem;
		font-weight: 600;
		color: #888;
		font-variant-numeric: tabular-nums;
		padding: 4px 12px;
		border-radius: 16px;
		background: #f0ebe4;
		transition: all 0.3s ease;
	}
	.sb-session-timer.warning {
		color: #fff;
		background: #dc2626;
		font-size: 1.1rem;
		padding: 6px 16px;
		animation: pulse-timer 1s ease-in-out infinite;
		box-shadow: 0 0 0 0 rgba(220, 38, 38, 0.4);
	}
	@keyframes pulse-timer {
		0%, 100% { box-shadow: 0 0 0 0 rgba(220, 38, 38, 0.4); }
		50% { box-shadow: 0 0 0 8px rgba(220, 38, 38, 0); }
	}
	.sb-end-btn {
		background: transparent;
		color: #c96442;
		border: 1px solid #e5e5e3;
		padding: 6px 16px;
		border-radius: 20px;
		font-size: 0.85rem;
		font-weight: 500;
		cursor: pointer;
		transition: all 0.2s;
		margin: 0;
	}
	.sb-end-btn:hover {
		background: #fef2f2;
		border-color: #c96442;
	}


	/* TTS text sync: spoken text is normal, upcoming text is dimmed */
	.tts-spoken {
		color: inherit;
	}
	.tts-upcoming {
		color: #b0a89e;
		transition: color 0.3s ease;
	}

	/* ── STAR Progress Panel ── */
	.sb-star-progress-panel {
		flex: 1;
		overflow-y: auto;
		padding: 24px;
	}
	.sb-star-progress-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 20px;
		padding-bottom: 12px;
		border-bottom: 1px solid #e5e5e3;
	}
	.sb-star-progress-header h3 {
		font-size: 1rem;
		font-weight: 600;
		color: #1a1a1a;
		text-align: left;
	}
	.sb-star-expand-btn {
		display: block;
		margin: 0 0 12px;
		font-size: 0.75rem;
		font-weight: 500;
		color: #c96442;
		background: none;
		border: 1px solid #e5e5e3;
		border-radius: 8px;
		padding: 2px 10px;
		cursor: pointer;
		transition: background 0.15s;
	}
	.sb-star-expand-btn:hover:not(:disabled) {
		background: #fef2f2;
	}
	.sb-star-expand-btn:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}
	.sb-star-progress-count {
		font-size: 0.8rem;
		font-weight: 600;
		color: #c96442;
		background: #fef2f2;
		padding: 2px 10px;
		border-radius: 12px;
	}
	.sb-star-progress-section {
		margin-bottom: 16px;
		border-radius: 10px;
		padding: 12px 14px;
		transition: all 0.3s ease;
	}
	.sb-star-progress-section.empty {
		background: #f9f9f8;
		border: 1px dashed #e5e5e3;
	}
	.sb-star-progress-section.filled {
		background: #faf8f5;
		border: 1px solid #e5e5e3;
		animation: sb-section-fill 0.6s ease;
	}
	@keyframes sb-section-fill {
		0% { background: #fef3e2; border-color: #c96442; box-shadow: 0 0 0 2px rgba(201, 100, 66, 0.19); }
		100% { background: #faf8f5; border-color: #e5e5e3; box-shadow: none; }
	}
	.sb-star-progress-label {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 0.8rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		margin-bottom: 4px;
	}
	.sb-star-progress-section.empty .sb-star-progress-label { color: #bbb; }
	.sb-star-progress-section.filled .sb-star-progress-label { color: #c96442; }
	.sb-star-progress-dot { font-size: 0.85rem; }
	.sb-star-progress-section.filled .sb-star-progress-dot { color: #16a34a; }
	.sb-star-progress-section.partial { background: #fdf6ec; border: 1px solid #f0d9a8; }
	.sb-star-progress-section.partial .sb-star-progress-label { color: #b8860b; }
	.sb-star-progress-section.partial .sb-star-progress-dot { color: #d9a520; }
	.sb-star-progress-content {
		font-size: 0.85rem;
		line-height: 1.6;
		color: #2d2d2d;
		margin-top: 6px;
		white-space: pre-wrap;
	}
	.sb-star-progress-hint {
		color: #bbb;
		font-size: 0.8rem;
		font-style: italic;
		text-align: center;
		margin-top: 24px;
		line-height: 1.5;
	}

	/* ── Report Layout ── */
	/* ── Scorecard ── */
	.sb-scorecard { padding: 32px 0; }
	.sb-scorecard h2 {
		font-size: 1.5rem;
		font-weight: 600;
		text-align: center;
		color: #1a1a1a;
		margin-bottom: 24px;
	}
	.sb-score-section {
		background: #ffffff;
		border: 1px solid #e5e5e3;
		border-radius: 12px;
		padding: 20px 24px;
		margin-bottom: 12px;
	}
	.sb-score-section h3 {
		font-size: 0.8rem;
		font-weight: 600;
		color: #b45309;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		margin-bottom: 12px;
		text-align: left;
	}
	.sb-report-star-section {
		margin-bottom: 16px;
	}
	.sb-report-star-label {
		font-weight: 600;
		font-size: 0.9rem;
		color: #555;
		margin-bottom: 4px;
	}
	.sb-report-star-content {
		background: #faf8f5;
		border-left: 3px solid #e07a5f;
		padding: 10px 14px;
		color: #2d2d2d;
		font-size: 0.92rem;
		line-height: 1.6;
		border-radius: 0 6px 6px 0;
	}
	.sb-full-story {
		background: #faf8f5;
		border: 1px solid #e5e5e3;
		border-radius: 8px;
		padding: 16px 20px;
		color: #2d2d2d;
		font-size: 0.95rem;
		line-height: 1.7;
		white-space: pre-wrap;
	}
	.sb-summary-note {
		color: #8a7a5c;
		font-size: 0.9rem;
		background: #fdf6ec;
		border: 1px solid #f0d9a8;
		border-radius: 8px;
		padding: 12px 16px;
		margin: 8px 0 16px;
	}
	.sb-summary-card {
		border-radius: 12px;
		padding: 14px 16px;
		margin-bottom: 12px;
		border: 1px solid #e5e5e3;
		background: #ffffff;
	}
	.sb-summary-card.green { background: #faf8f5; }
	.sb-summary-card.yellow { background: #fdf6ec; border-color: #f0d9a8; }
	.sb-summary-card.none { background: #f9f9f8; border-style: dashed; }
	.sb-summary-card-head {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 0.8rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: #555;
	}
	.sb-summary-card.green .sb-summary-dot { color: #16a34a; }
	.sb-summary-card.yellow .sb-summary-dot { color: #d9a520; }
	.sb-summary-card.none .sb-summary-dot { color: #bbb; }
	.sb-summary-points {
		margin: 8px 0 0;
		padding-left: 18px;
		color: #2d2d2d;
		font-size: 0.9rem;
		line-height: 1.6;
	}
	.sb-summary-strong {
		margin: 8px 0 0;
		color: #16a34a;
		font-size: 0.85rem;
	}
	.sb-summary-missing {
		margin: 6px 0 0;
		color: #b8860b;
		font-size: 0.85rem;
	}
	.sb-scorecard-actions {
		text-align: center;
		padding: 24px 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 12px;
	}
	.sb-error-dashboard-link {
		font-size: 0.85rem;
		color: #8E8CA0;
		text-decoration: none;
		&:hover {
			color: #2D2B3D;
			text-decoration: underline;
		}
	}
	.sb-glitch-notice {
		color: #c96442 !important;
		font-weight: 600;
		font-size: 0.88rem;
		margin-top: 12px;
	}

	/* Inline support form */
	.sb-support-inline {
		margin-top: 28px;
		padding-top: 24px;
		border-top: 1px solid #f0ece6;
		text-align: center;
	}
	.sb-support-inline h4 {
		font-size: 0.95rem;
		font-weight: 700;
		color: #2D2B3D;
		margin: 0 0 4px;
	}
	.sb-support-hint {
		font-size: 0.82rem;
		color: #8E8CA0;
		margin: 0 0 12px;
	}
	.sb-support-textarea {
		display: block;
		width: 100%;
		box-sizing: border-box;
		padding: 12px 14px;
		border: 1px solid #e0dcd6;
		border-radius: 10px;
		font-size: 0.88rem;
		font-family: inherit;
		color: #2D2B3D;
		resize: vertical;
		line-height: 1.5;
		margin-bottom: 12px;
		&:focus {
			outline: none;
			border-color: #c96442;
		}
		&::placeholder {
			color: #bbb;
		}
	}
	.sb-support-btns {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
	}
	.sb-support-cancel {
		padding: 8px 18px;
		border: 1px solid #e0dcd6;
		border-radius: 20px;
		background: white;
		font-size: 0.85rem;
		font-weight: 600;
		color: #8E8CA0;
		cursor: pointer;
		&:hover { border-color: #ccc; color: #2D2B3D; }
	}
	.sb-support-submit {
		padding: 8px 22px;
		border: none;
		border-radius: 20px;
		background: #c96442;
		color: white;
		font-size: 0.85rem;
		font-weight: 600;
		cursor: pointer;
		&:hover:not(:disabled) { background: #b5593a; }
		&:disabled { opacity: 0.5; cursor: not-allowed; }
	}
	.sb-support-trigger {
		background: none;
		border: none;
		font-size: 0.85rem;
		color: #8E8CA0;
		cursor: pointer;
		padding: 0;
		&:hover { color: #c96442; text-decoration: underline; }
	}
	.sb-support-done {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 8px;
	}
	.sb-support-done-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 36px;
		height: 36px;
		border-radius: 50%;
		background: #e8f5e9;
		color: #2e7d32;
		font-size: 1rem;
		font-weight: 700;
	}
	.sb-support-done p {
		font-size: 0.85rem;
		color: #8E8CA0;
		margin: 0;
	}

	/* ── Strength Signals Card ── */
	.sb-signals-card {
		background: #fff;
		border: 1px solid #e5e5e3;
		border-radius: 16px;
		padding: 28px;
		margin-top: 20px;
	}
	.sb-signals-card h3 {
		font-size: 1.1rem;
		font-weight: 700;
		color: #2d2b3d;
		margin: 0 0 4px;
		text-align: left;
	}
	.sb-signals-subtitle {
		font-size: 0.84rem;
		color: #999;
		margin: 0 0 20px;
	}
	.sb-signals-loading {
		font-size: 0.88rem;
		color: #999;
		font-style: italic;
	}
	.sb-signals-group {
		margin-bottom: 20px;
		&:last-child { margin-bottom: 0; }
	}
	.sb-signals-group-label {
		font-size: 0.78rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		margin-bottom: 10px;
	}
	.sb-signals-strong-label { color: #2e7d32; }
	.sb-signals-improve-label { color: #c96442; }

	.sb-signal-item {
		display: flex;
		gap: 10px;
		padding: 10px 0;
		border-bottom: 1px solid #f0ece6;
		&:last-child { border-bottom: none; }
	}
	.sb-signal-icon {
		flex-shrink: 0;
		width: 22px;
		height: 22px;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 50%;
		font-size: 0.75rem;
		font-weight: 700;
		margin-top: 2px;
	}
	.sb-signal-strong .sb-signal-icon {
		background: #e8f5e9;
		color: #2e7d32;
	}
	.sb-signal-improve .sb-signal-icon {
		background: #fff3e0;
		color: #c96442;
	}
	.sb-signal-name {
		font-weight: 700;
		font-size: 0.9rem;
		color: #2d2b3d;
		margin-right: 6px;
	}
	.sb-signal-explain {
		font-size: 0.88rem;
		color: #666;
		line-height: 1.45;
	}

	/* ── Watch Out Flags ── */
	.sb-flags-card {
		background: #fff;
		border: 1px solid #e5e5e3;
		border-radius: 16px;
		padding: 28px;
		margin-top: 20px;
	}
	.sb-flags-card h3 {
		font-size: 1.1rem;
		font-weight: 700;
		color: #2d2b3d;
		margin: 0 0 4px;
		text-align: left;
	}
	.sb-flags-subtitle {
		font-size: 0.84rem;
		color: #999;
		margin: 0 0 20px;
	}
	.sb-flag-item {
		display: flex;
		gap: 10px;
		padding: 10px 0;
		border-bottom: 1px solid #f0ece6;
		&:last-child { border-bottom: none; }
	}
	.sb-flag-icon {
		flex-shrink: 0;
		width: 22px;
		height: 22px;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 50%;
		font-size: 0.75rem;
		font-weight: 700;
		margin-top: 2px;
		background: #fff3e0;
		color: #e65100;
	}
	.sb-flag-text {
		font-weight: 700;
		font-size: 0.9rem;
		color: #2d2b3d;
		display: block;
		margin-bottom: 2px;
	}
	.sb-flag-suggestion {
		font-size: 0.88rem;
		color: #666;
		line-height: 1.45;
	}

	/* ── Responsive ── */
	@media (max-width: 1024px) {
		.sb-coaching-layout { flex-direction: column; }
		.sb-coaching-main { max-width: 100%; }
		.sb-coaching-sidebar {
			width: 100% !important;
			height: auto;
			position: relative;
			top: 0;
			border-top: 1px solid #e5e5e3;
			max-height: 300px;
		}
		.sb-coaching-resize-handle { display: none; }
	}
	@media (max-width: 600px) {
		.sb-container { padding: 16px 16px 0; }
		.sb-coaching-main { padding: 16px 16px 0; }
	}

	/* ══════════ TOAST ══════════ */
	.toast {
		position: fixed;
		top: 72px;
		left: 50%;
		transform: translateX(-50%);
		z-index: 2000;
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 14px 24px;
		border-radius: 12px;
		font-size: 14px;
		font-weight: 500;
		box-shadow: 0 8px 30px rgba(0, 0, 0, 0.15);
		cursor: pointer;
		animation: toast-in 0.3s ease-out;
		max-width: 520px;
	}

	.toast-error {
		background: #FFF0F0;
		color: #C53030;
		border: 1px solid #FEB2B2;
	}

	.toast-success {
		background: #F0FFF4;
		color: #276749;
		border: 1px solid #9AE6B4;
	}

	.toast-info {
		background: #EBF8FF;
		color: #2B6CB0;
		border: 1px solid #90CDF4;
	}

	.toast-icon { font-size: 18px; }
	.toast-msg { flex: 1; }
	.toast-close {
		font-size: 20px;
		opacity: 0.5;
		&:hover { opacity: 1; }
	}

	@keyframes toast-in {
		from { opacity: 0; transform: translateX(-50%) translateY(-12px); }
		to { opacity: 1; transform: translateX(-50%) translateY(0); }
	}
</style>
