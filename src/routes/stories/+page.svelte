<script lang="ts">
	import { goto } from '$app/navigation';
	import { tz } from '$lib/stores/tz';

	export let data;

	$: stories = data.stories || [];

	let expandedId: string | null = null;

	const toggleExpand = (id: string) => {
		expandedId = expandedId === id ? null : id;
	};

	const formatDate = (dateStr: string, zone?: string) => {
		const d = new Date(dateStr);
		return d.toLocaleDateString('en-US', {
			month: 'short',
			day: 'numeric',
			year: 'numeric',
			timeZone: zone,
		});
	};

	// Stories saved before the grounded-assessment redesign used a different shape:
	//   talking_points: { situation: string[] }          (old)  vs  { situation: { talkingPoints, strong, missing } }  (new)
	//   strength_signals: { strong, improve }            (old)  vs  { strengths, growth }                              (new)
	// These normalizers read either shape so old and new rows both render.
	const SECTION_KEYS = ['situation', 'task', 'action', 'result'];

	const sectionOf = (story: any, key: string) => {
		const tp = story.talking_points?.[key];
		if (!tp) return null;
		if (Array.isArray(tp)) return { points: tp, strong: null, missing: null };
		return {
			points: Array.isArray(tp.talkingPoints) ? tp.talkingPoints : [],
			strong: tp.strong ?? null,
			missing: tp.missing ?? null,
		};
	};

	const hasTalkingPoints = (story: any) =>
		!!story.talking_points &&
		SECTION_KEYS.some(k => {
			const s = sectionOf(story, k);
			return s && (s.points.length || s.strong || s.missing);
		});

	const strengthsOf = (story: any) => {
		const sig = story.strength_signals;
		if (!sig) return [];
		const list = sig.strengths ?? sig.strong ?? [];
		return Array.isArray(list) ? list : [];
	};

	const growthOf = (story: any) => {
		const sig = story.strength_signals;
		if (!sig) return [];
		const list = sig.growth ?? sig.improve ?? [];
		return Array.isArray(list) ? list : [];
	};

	// Old rows used `explanation`; new rows use `evidence` (strengths) / `detail` (growth).
	const signalText = (item: any) => item.evidence ?? item.detail ?? item.explanation ?? '';

	const hasSignals = (story: any) => strengthsOf(story).length > 0 || growthOf(story).length > 0;

	// A story exists from its first sitting now (not just at save time), so the
	// bank shows in-progress ones with a way back in. Everything a resume needs is
	// the story id — it goes in the URL so a refresh resumes rather than restarts.
	const inProgress = (story: any) => story.status === 'in_progress';
	const titleOf = (story: any) => story.question || story.extracted_question || null;
	const greenCount = (story: any) =>
		SECTION_KEYS.filter(k => !!story.star_sections?.[k]).length;
	const lastActive = (story: any, zone?: string) => {
		const d = new Date(story.updated_at || story.created_at);
		const days = Math.floor((Date.now() - d.getTime()) / 86400000);
		if (days === 0) return 'today';
		if (days === 1) return 'yesterday';
		if (days < 7) return `${days} days ago`;
		return formatDate(d.toISOString(), zone);
	};
	const resume = (story: any) => goto(`/storybuilder?story=${story.id}`);
</script>

<div class="sb-page">
	<div class="sb-back-row">
		<a href="/dashboard" class="sb-back">&larr; Dashboard</a>
	</div>
	<div class="sb-inner">
		<div class="sb-header">
			<h1>My Story Bank</h1>
			<p class="sb-subtitle">Your finished stories, and the ones still in the works.</p>
		</div>

		{#if stories.length === 0}
			<div class="sb-empty">
				<p>No stories yet. Complete a coaching session and your first story will appear here.</p>
			</div>
			<div class="sb-empty-action">
				<button class="sb-cta-btn" on:click={() => goto('/storybuilder')}>Build Your First Story</button>
			</div>
		{:else}
			<div class="sb-stories">
				{#each stories as story}
					<!-- svelte-ignore a11y-click-events-have-key-events -->
					<!-- svelte-ignore a11y-no-static-element-interactions -->
					<div class="sb-story-card" class:sb-story-expanded={expandedId === story.id} class:sb-story-inprogress={inProgress(story)} class:sb-story-complete={!inProgress(story)} on:click={() => toggleExpand(story.id)}>
						<div class="sb-story-top">
							<div class="sb-story-info">
								{#if inProgress(story)}
									<span class="sb-story-badge sb-badge-progress">In progress · {greenCount(story)} of 4 sections solid</span>
								{:else}
									<span class="sb-story-badge sb-badge-complete">Completed</span>
								{/if}
								{#if story.expired}
									<span class="sb-story-badge sb-badge-ended">Resume window ended</span>
								{/if}
								<h3 class:untitled={!titleOf(story)}>{titleOf(story) || (inProgress(story) ? 'Untitled story — question not settled yet' : 'Undefined interview question')}</h3>
							</div>
							<div class="sb-story-meta">
								{#if story.expired}
									<span class="sb-story-date">ended {formatDate(story.expiresAt, $tz)}</span>
									<button class="sb-continue-btn" on:click|stopPropagation={() => goto(`/credits?finish=${story.id}`)}>{inProgress(story) ? 'Finish' : 'Sharpen'} for $6</button>
								{:else if inProgress(story)}
									<span class="sb-story-date">last worked on {lastActive(story, $tz)}</span>
									<button class="sb-continue-btn" on:click|stopPropagation={() => resume(story)}>Continue</button>
								{:else}
									<span class="sb-story-date">{formatDate(story.created_at, $tz)}</span>
									<button class="sb-sharpen-btn" on:click|stopPropagation={() => resume(story)}>Sharpen</button>
								{/if}
								<span class="sb-story-toggle">{expandedId === story.id ? '▲' : '▼'}</span>
							</div>
						</div>

						{#if expandedId === story.id && inProgress(story)}
							<div class="sb-story-body" on:click|stopPropagation>
								{#if greenCount(story) > 0}
									<div class="sb-section">
										<h4>Solid so far</h4>
										<div class="sb-tp-grid">
											{#each SECTION_KEYS as sKey}
												{#if story.star_sections?.[sKey]}
													<div class="sb-tp-group">
														<span class="sb-tp-label">{sKey.charAt(0).toUpperCase() + sKey.slice(1)}</span>
														<p class="sb-story-text sb-story-text-sm">{story.star_sections[sKey]}</p>
													</div>
												{/if}
											{/each}
										</div>
									</div>
								{:else}
									<p class="sb-signals-hint">Nothing solid yet — pick up where you left off and the sections will fill in as you go.</p>
								{/if}
							</div>
						{:else if expandedId === story.id}
							<div class="sb-story-body" on:click|stopPropagation>
								{#if story.full_story}
									<div class="sb-section">
										<h4>Your Polished Answer</h4>
										<p class="sb-story-text">{story.full_story}</p>
									</div>
								{/if}

								{#if hasTalkingPoints(story)}
									<div class="sb-section">
										<h4>Talking Points</h4>
										<div class="sb-tp-grid">
											{#each SECTION_KEYS as sKey}
												{@const sec = sectionOf(story, sKey)}
												{#if sec && (sec.points.length || sec.strong || sec.missing)}
													<div class="sb-tp-group">
														<span class="sb-tp-label">{sKey.charAt(0).toUpperCase() + sKey.slice(1)}</span>
														{#if sec.points.length}
															<ul>
																{#each sec.points as point}
																	<li>{point}</li>
																{/each}
															</ul>
														{/if}
														{#if sec.strong}<p class="sb-tp-strong">✓ {sec.strong}</p>{/if}
														{#if sec.missing}<p class="sb-tp-missing">↗ {sec.missing}</p>{/if}
													</div>
												{/if}
											{/each}
										</div>
									</div>
								{/if}

								{#if hasSignals(story)}
									<div class="sb-section">
										<h4>Strengths &amp; growth</h4>
										<p class="sb-signals-hint">Based on what you actually shared in the session.</p>
										{#if strengthsOf(story).length}
											<div class="sb-sig-group">
												<span class="sb-sig-label sb-sig-label-strong">Strengths</span>
												{#each strengthsOf(story) as item}
													<div class="sb-sig-item">
														<span class="sb-sig-icon sb-sig-icon-strong">✓</span>
														<div>
															<span class="sb-sig-name">{item.signal}</span>
															<span class="sb-sig-explain">{signalText(item)}</span>
														</div>
													</div>
												{/each}
											</div>
										{/if}
										{#if growthOf(story).length}
											<div class="sb-sig-group">
												<span class="sb-sig-label sb-sig-label-improve">Growth areas</span>
												{#each growthOf(story) as item}
													<div class="sb-sig-item">
														<span class="sb-sig-icon sb-sig-icon-improve">⚡</span>
														<div>
															<span class="sb-sig-name">{item.signal}</span>
															<span class="sb-sig-explain">{signalText(item)}</span>
														</div>
													</div>
												{/each}
											</div>
										{/if}
									</div>
								{/if}

								{#if story.flags?.length}
									<div class="sb-section">
										<h4>Watch Out</h4>
										<p class="sb-signals-hint">Things to avoid saying in the real interview.</p>
										{#each story.flags as item}
											<div class="sb-flag-item">
												<span class="sb-flag-icon">⚠</span>
												<div>
													<span class="sb-flag-text">{item.flag}</span>
													<span class="sb-flag-explain">{item.suggestion}</span>
												</div>
											</div>
										{/each}
									</div>
								{/if}
							</div>
						{/if}
					</div>
				{/each}
			</div>
		{/if}
	</div>
</div>

<style lang="scss">
	@import '$lib/styles/colors.scss';

	.sb-page {
		min-height: 100vh;
		background: $bg-warm;
	}

	.sb-back-row {
		max-width: 1200px;
		margin: 0 auto;
		padding: 68px 20px 0;
	}

	.sb-back {
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

	.sb-inner {
		max-width: 1000px;
		margin: 0 auto;
		padding: 32px 24px 60px;
	}

	.sb-header {
		margin-bottom: 28px;
	}
	.sb-header h1 {
		font-size: 1.8rem;
		font-weight: 700;
		color: $text-dark;
		margin: 0 0 8px;
	}
	.sb-subtitle {
		color: $text-light;
		font-size: 1rem;
		margin: 0;
	}

	/* Empty state */
	.sb-empty {
		background: white;
		border-radius: 16px;
		padding: 48px 32px;
		text-align: center;
		box-shadow: $card-shadow;
		p {
			color: $text-light;
			font-size: 0.95rem;
			margin: 0;
		}
	}
	.sb-empty-action {
		text-align: center;
		margin-top: 24px;
	}
	.sb-cta-btn {
		background: #c96442;
		color: white;
		border: none;
		padding: 12px 32px;
		border-radius: 24px;
		font-size: 1rem;
		font-weight: 600;
		cursor: pointer;
		transition: background 0.2s, transform 0.1s;
		margin: 0 auto;
		display: block;
		&:hover {
			background: #b5593a;
			transform: translateY(-1px);
		}
	}

	/* Story cards */
	.sb-stories {
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	.sb-story-card {
		background: white;
		border-radius: 16px;
		padding: 24px 28px;
		box-shadow: $card-shadow;
		cursor: pointer;
		transition: box-shadow 0.2s, transform 0.15s;
		border: 2px solid transparent;
		&:hover {
			box-shadow: $card-shadow-hover;
			transform: translateY(-1px);
		}
	}
	/* Incomplete sessions are kept (the user paid for them) but shown distinctly. */
	/* Tile color follows STATUS only. The window is a badge + button, never a color. */
	.sb-story-card.sb-story-inprogress {
		background: #fff8e6;
		border: 1px dashed #e6c46a;
	}
	.sb-story-card.sb-story-complete {
		background: #f1f8ee;
		border: 1px dashed #9ccc8a;
	}
	.sb-story-badge {
		display: inline-block;
		font-size: 0.65rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: #8a5a00;
		background: #fdecc0;
		border-radius: 10px;
		padding: 2px 8px;
		margin-bottom: 6px;
		margin-right: 6px;
	}
	.sb-badge-ended {
		color: #666;
		background: #ececec;
	}
	.sb-badge-complete {
		color: #2f6b1f;
		background: #d9efd0;
	}
	.sb-badge-progress {
		color: #8a5a00;
		background: #fdecc0;
	}
	.sb-continue-btn, .sb-sharpen-btn {
		border: none;
		border-radius: 20px;
		padding: 7px 16px;
		font-size: 0.82rem;
		font-weight: 600;
		cursor: pointer;
		transition: background 0.2s, transform 0.1s;
		&:hover { transform: translateY(-1px); }
	}
	.sb-continue-btn {
		background: #c96442;
		color: white;
		&:hover { background: #b5593a; }
	}
	.sb-sharpen-btn {
		background: transparent;
		color: #c96442;
		border: 1px solid #c96442;
		&:hover { background: #fbe7dc; }
	}
	.sb-story-text-sm {
		font-size: 0.84rem;
		line-height: 1.5;
	}
	.sb-story-info h3.untitled {
		font-style: italic;
		color: #999;
	}
	.sb-story-expanded {
		border-color: #e5e5e3;
		cursor: default;
	}

	.sb-story-top {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 16px;
	}
	.sb-story-info {
		flex: 1;
		min-width: 0;
	}
	.sb-story-info h3 {
		font-size: 1.05rem;
		font-weight: 700;
		color: $text-dark;
		margin: 0;
		text-align: left;
	}
	.sb-story-question {
		font-size: 0.88rem;
		color: $text-light;
		font-style: italic;
		margin: 4px 0 0;
	}
	.sb-story-meta {
		display: grid;
		grid-template-columns: auto auto auto;
		grid-auto-flow: column;
		align-items: center;
		column-gap: 14px;
		flex-shrink: 0;
		white-space: nowrap;
		/* A library stylesheet gives <button> its own display/margins, which pushed
		   it ~12px below the date and chevron. Pin every child to the row's center. */
		> * {
			align-self: center;
			margin: 0;
			line-height: 1.2;
		}
	}
	.sb-story-date {
		font-size: 0.82rem;
		color: $text-light;
		white-space: nowrap;
	}
	.sb-story-toggle {
		font-size: 0.7rem;
		color: #ccc;
	}

	/* Expanded body */
	.sb-story-body {
		margin-top: 20px;
		padding-top: 20px;
		border-top: 1px solid #f0ece6;
		cursor: default;
	}

	.sb-section {
		margin-bottom: 24px;
		&:last-child { margin-bottom: 0; }
	}
	.sb-section h4 {
		font-size: 0.9rem;
		font-weight: 700;
		color: $text-dark;
		margin: 0 0 10px;
		text-align: left;
	}
	.sb-story-text {
		font-size: 0.9rem;
		line-height: 1.7;
		color: #444;
		white-space: pre-wrap;
		margin: 0;
	}

	/* Talking points */
	.sb-tp-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 12px;
		@media (max-width: 600px) { grid-template-columns: 1fr; }
	}
	.sb-tp-group {
		background: $bg-warm;
		padding: 14px;
		border-radius: 10px;
	}
	.sb-tp-label {
		display: block;
		font-size: 0.72rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: $text-light;
		margin-bottom: 6px;
	}
	.sb-tp-strong {
		margin: 6px 0 0;
		font-size: 0.82rem;
		color: #16a34a;
	}
	.sb-tp-missing {
		margin: 4px 0 0;
		font-size: 0.82rem;
		color: #b8860b;
	}
	.sb-tp-group ul {
		margin: 0;
		padding-left: 16px;
	}
	.sb-tp-group li {
		font-size: 0.84rem;
		color: #555;
		margin-bottom: 4px;
		line-height: 1.4;
		list-style-type: disc;
	}

	/* Strength signals */
	.sb-signals-hint {
		font-size: 0.82rem;
		color: $text-light;
		margin: 0 0 14px;
	}
	.sb-sig-group {
		margin-bottom: 14px;
		&:last-child { margin-bottom: 0; }
	}
	.sb-sig-label {
		display: inline-block;
		font-size: 0.72rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		margin-bottom: 8px;
	}
	.sb-sig-label-strong { color: #2e7d32; }
	.sb-sig-label-improve { color: #c96442; }

	.sb-sig-item {
		display: flex;
		gap: 10px;
		padding: 8px 0;
		border-bottom: 1px solid #f0ece6;
		&:last-child { border-bottom: none; }
	}
	.sb-sig-icon {
		flex-shrink: 0;
		width: 22px;
		height: 22px;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 50%;
		font-size: 0.72rem;
		font-weight: 700;
		margin-top: 1px;
	}
	.sb-sig-icon-strong { background: #e8f5e9; color: #2e7d32; }
	.sb-sig-icon-improve { background: #fff3e0; color: #c96442; }
	.sb-sig-name {
		font-weight: 700;
		font-size: 0.88rem;
		color: $text-dark;
		margin-right: 5px;
	}
	.sb-sig-explain {
		font-size: 0.86rem;
		color: #666;
		line-height: 1.45;
	}

	/* Flags */
	.sb-flag-item {
		display: flex;
		gap: 10px;
		padding: 8px 0;
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
		font-size: 0.72rem;
		font-weight: 700;
		margin-top: 1px;
		background: #fff3e0;
		color: #e65100;
	}
	.sb-flag-text {
		font-weight: 700;
		font-size: 0.88rem;
		color: $text-dark;
		display: block;
		margin-bottom: 2px;
	}
	.sb-flag-explain {
		font-size: 0.86rem;
		color: #666;
		line-height: 1.45;
	}

	@media (max-width: 600px) {
		.sb-header h1 { font-size: 1.5rem; }
		.sb-story-top { flex-direction: column; align-items: flex-start; gap: 10px; }
	}
</style>
