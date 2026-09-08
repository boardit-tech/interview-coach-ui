<script lang="ts">
	import { userStore } from '$lib/stores/userStore';
	import { goto } from '$app/navigation';

	export let data;

	$: firstName = (data.username || '').split(' ')[0] || 'there';
	$: recentStories = data.recentStories || [];
	$: totalStories = data.totalStories || 0;
	$: recentSessions = data.recentSessions || [];

	const formatDate = (dateStr: string) => {
		const d = new Date(dateStr);
		return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
	};

	const formatSessionDate = (dateStr: string) => {
		const d = new Date(dateStr);
		return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
	};

	const getGreeting = () => {
		const hour = new Date().getHours();
		if (hour < 12) return 'Good morning';
		if (hour < 17) return 'Good afternoon';
		return 'Good evening';
	};

	// Support modal
	let showSupportModal = false;
	let supportTopic = '';
	let supportSessionId = '';
	let supportDescription = '';
	let supportSubmitting = false;
	let supportSubmitted = false;

	const openSupport = () => {
		supportTopic = '';
		supportSessionId = '';
		supportDescription = '';
		supportSubmitted = false;
		showSupportModal = true;
	};

	const closeSupport = () => {
		showSupportModal = false;
	};

	const submitSupport = async () => {
		if (!supportTopic || !supportDescription.trim()) return;
		supportSubmitting = true;
		try {
			const res = await fetch('/dashboard/api/support', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					topic: supportTopic,
					sessionId: supportSessionId || null,
					description: supportDescription.trim(),
				}),
			});
			const result = await res.json();
			if (result.success) {
				supportSubmitted = true;
			}
		} catch (err) {
			console.error('Failed to submit support request:', err);
		} finally {
			supportSubmitting = false;
		}
	};
</script>

<div class="dash">
	<div class="dash-inner">
		<!-- Greeting -->
		<div class="dash-greeting">
			<h1>{getGreeting()}, <span class="dash-name">{firstName}</span></h1>
			<p class="dash-subtitle">Ready to impress with your interview stories?</p>
		</div>

		<!-- Top cards row -->
		<div class="dash-cards">
			<!-- CTA card -->
			<div class="dash-card dash-cta-card">
				<h2>Build a new story</h2>
				<p>20 minutes with your AI coach to turn a real experience into a remarkable story that interviewers remember.</p>
				<button class="dash-cta-btn" on:click={() => goto('/storybuilder')}>
					Start Building
				</button>
			</div>

			<!-- Achievement card -->
			<div class="dash-card dash-progress-card">
				<h3>Achievements</h3>
				<div class="dash-stats">
					<div class="dash-stat">
						<span class="dash-stat-value">{totalStories}</span>
						<span class="dash-stat-label">{totalStories === 1 ? 'Story' : 'Stories'} Built</span>
					</div>
					<div class="dash-stat">
						{#if $userStore.subscriptionID}
							<span class="dash-stat-value">Unlimited credits</span>
							<span class="dash-stat-label">Subscription Active</span>
						{:else}
							<span class="dash-stat-value">{$userStore.credits}</span>
							<span class="dash-stat-label">Credit{$userStore.credits !== 1 ? 's' : ''} Left</span>
						{/if}
					</div>
				</div>
				{#if $userStore.subscriptionID && $userStore.credits > 0}
					<span class="dash-credits-note">Your subscription is used first. Your {$userStore.credits} purchased credit{$userStore.credits !== 1 ? 's' : ''} will kick in if it ends.</span>
				{/if}
				<div class="dash-card-actions">
					{#if $userStore.subscriptionID}
						<a href="/credits" class="dash-action-link">Manage Subscription</a>
					{:else}
						<a href="/credits" class="dash-action-link">Buy More Credits</a>
						<span class="dash-action-divider">·</span>
						<a href="/credits" class="dash-action-link">Subscribe</a>
					{/if}
					<span class="dash-action-divider">·</span>
					<!-- svelte-ignore a11y-click-events-have-key-events -->
					<!-- svelte-ignore a11y-no-static-element-interactions -->
					<span class="dash-help-link" on:click={openSupport}>Need help?</span>
				</div>
			</div>
		</div>

		<!-- Recent stories (in-progress ones link straight back into the session) -->
		<div class="dash-section">
			<div class="dash-section-header">
				<h3>Recent Stories</h3>
			</div>

			{#if recentStories.length === 0}
				<div class="dash-empty">
					<p>No stories yet. Complete your first coaching session and your story will appear here.</p>
				</div>
			{:else}
				<div class="dash-stories-grid">
					{#each recentStories as story}
						{@const inProgress = story.status === 'in_progress'}
						{@const title = story.question || story.extracted_question}
						{@const green = ['situation', 'task', 'action', 'result'].filter(k => !!story.star_sections?.[k]).length}
						<a href={inProgress ? `/storybuilder?story=${story.id}` : '/stories'} class="dash-story-card" class:incomplete={!inProgress && story.tier === 'partial'} class:inprogress={inProgress}>
							{#if inProgress}
								<span class="dash-story-badge dash-badge-progress">In progress · {green}/4</span>
							{:else if story.tier === 'partial'}
								<span class="dash-story-badge">Incomplete</span>
							{/if}
							<span class="dash-story-title" class:untitled={!title}>
								{title || (inProgress ? 'Untitled story' : 'Undefined interview question')}
							</span>
							<span class="dash-story-date">{inProgress ? 'Continue →' : formatDate(story.created_at)}</span>
						</a>
					{/each}
				</div>
			{/if}

			<div class="dash-section-footer">
				<a href="/stories" class="dash-bank-btn">Go to My Story Bank &rarr;</a>
			</div>
		</div>
	</div>

	<!-- Support modal -->
	{#if showSupportModal}
		<!-- svelte-ignore a11y-click-events-have-key-events -->
		<!-- svelte-ignore a11y-no-static-element-interactions -->
		<div class="modal-overlay" on:click={closeSupport}>
			<!-- svelte-ignore a11y-click-events-have-key-events -->
			<!-- svelte-ignore a11y-no-static-element-interactions -->
			<div class="modal-content" on:click|stopPropagation>
				{#if supportSubmitted}
					<div class="modal-success">
						<span class="modal-success-icon">✓</span>
						<h3>Request submitted</h3>
						<p>We'll review your request and get back to you within 24 hours.</p>
						<button class="modal-close-btn" on:click={closeSupport}>Close</button>
					</div>
				{:else}
					<h3 class="modal-title">How can we help?</h3>
					<p class="modal-subtitle">We'll review your request and respond within 24 hours.</p>

					<label class="modal-label">Topic</label>
					<select class="modal-select" bind:value={supportTopic}>
						<option value="" disabled>Select a topic…</option>
						<option value="credit_refund">Session issue / Credit refund</option>
						<option value="bug_report">Bug report</option>
						<option value="feature_request">Feature request</option>
						<option value="other">Other</option>
					</select>

					{#if supportTopic === 'credit_refund' && recentSessions.length > 0}
						<label class="modal-label">Which session?</label>
						<select class="modal-select" bind:value={supportSessionId}>
							<option value="">Not sure / general</option>
							{#each recentSessions as s}
								<option value={s.session_id}>
									{formatSessionDate(s.created_at)} — {s.status}
								</option>
							{/each}
						</select>
					{/if}

					<label class="modal-label">What happened?</label>
					<textarea class="modal-textarea" bind:value={supportDescription} placeholder="Describe the issue — the more detail the better." rows="4"></textarea>

					<div class="modal-actions">
						<button class="modal-cancel" on:click={closeSupport}>Cancel</button>
						<button
							class="modal-submit"
							on:click={submitSupport}
							disabled={!supportTopic || !supportDescription.trim() || supportSubmitting}
						>
							{supportSubmitting ? 'Submitting…' : 'Submit'}
						</button>
					</div>
				{/if}
			</div>
		</div>
	{/if}
</div>

<style lang="scss">
	@import '$lib/styles/colors.scss';

	.dash {
		min-height: calc(100vh - 56px);
		padding-top: 56px;
		background: $bg-warm;
	}

	.dash-inner {
		max-width: 860px;
		margin: 0 auto;
		padding: 48px 24px 60px;
	}

	/* Greeting */
	.dash-greeting {
		margin-bottom: 36px;
	}
	.dash-greeting h1 {
		font-size: 1.8rem;
		font-weight: 600;
		color: $text-dark;
		margin: 0 0 6px;
	}
	.dash-name {
		color: $primary;
	}
	.dash-subtitle {
		color: $text-light;
		font-size: 1rem;
		margin: 0;
	}

	/* Cards row */
	.dash-cards {
		display: grid;
		grid-template-columns: 1.2fr 1fr;
		gap: 20px;
		margin-bottom: 40px;
	}

	.dash-card {
		background: white;
		border-radius: 16px;
		padding: 28px;
		box-shadow: $card-shadow;
		transition: box-shadow 0.2s;
	}

	/* CTA card */
	.dash-cta-card {
		display: flex;
		flex-direction: column;
	}
	.dash-cta-icon {
		font-size: 2rem;
		margin-bottom: 12px;
	}
	.dash-cta-card h2 {
		font-size: 1.25rem;
		font-weight: 700;
		color: $text-dark;
		margin: 0 0 8px;
	}
	.dash-cta-card p {
		color: $text-medium;
		font-size: 0.9rem;
		line-height: 1.5;
		margin: 0 0 20px;
		flex: 1;
	}
	.dash-cta-btn {
		background: #c96442;
		color: white;
		border: none;
		padding: 12px 32px;
		border-radius: 24px;
		font-size: 1rem;
		font-weight: 600;
		cursor: pointer;
		transition: background 0.2s, transform 0.1s;
		align-self: flex-start;
		&:hover {
			background: #b5593a;
			transform: translateY(-1px);
		}
		&:active {
			transform: translateY(0);
		}
	}

	/* Progress card */
	.dash-progress-card {
		display: flex;
		flex-direction: column;
	}
	.dash-progress-card h3 {
		font-size: 0.8rem;
		font-weight: 600;
		color: $text-light;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		margin: 0 0 20px;
		text-align: left;
	}
	.dash-stats {
		display: flex;
		flex-direction: column;
		gap: 16px;
		flex: 1;
	}
	.dash-stat {
		display: flex;
		align-items: baseline;
		gap: 10px;
	}
	.dash-stat-value {
		font-size: 1.6rem;
		font-weight: 700;
		color: $text-dark;
		line-height: 1;
	}
	.dash-stat-label {
		font-size: 0.85rem;
		color: $text-light;
	}
	.dash-card-actions {
		margin-top: auto;
		padding-top: 16px;
	}
	.dash-action-link {
		font-size: 0.85rem;
		color: $primary;
		text-decoration: none;
		font-weight: 600;
		&:hover {
			text-decoration: underline;
		}
	}
	.dash-action-divider {
		color: $text-light;
		margin: 0 6px;
	}
	.dash-credits-note {
		display: block;
		margin-top: 12px;
		font-size: 0.8rem;
		color: $text-light;
		line-height: 1.4;
	}

	/* Recent stories section */
	.dash-section {
		margin-bottom: 24px;
	}
	.dash-section-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 16px;
	}
	.dash-section-header h3 {
		font-size: 1.05rem;
		font-weight: 600;
		color: $text-dark;
		margin: 0;
		text-align: left;
	}
	.dash-view-all {
		font-size: 0.85rem;
		color: $primary;
		text-decoration: none;
		font-weight: 600;
		&:hover {
			text-decoration: underline;
		}
	}

	.dash-stories-grid {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 14px;
	}

	.dash-story-card {
		background: white;
		border-radius: 12px;
		padding: 20px;
		box-shadow: $card-shadow;
		text-decoration: none;
		display: flex;
		flex-direction: column;
		gap: 8px;
		transition: box-shadow 0.2s, transform 0.15s;
		&:hover {
			box-shadow: $card-shadow-hover;
			transform: translateY(-2px);
		}
	}
	/* Incomplete sessions still live in the Story Bank — the user paid for them —
	   but are visually distinct from finished, interview-ready stories. */
	.dash-story-card.incomplete {
		background: #fdeceb;
		border: 1px dashed #f0b8b2;
	}
	/* In-progress stories: resumable, so the card links straight into the session. */
	.dash-story-card.inprogress {
		border: 1px solid #f3d9c9;
	}
	.dash-badge-progress {
		color: #9a4a2e !important;
		background: #fbe7dc !important;
	}
	.dash-story-badge {
		align-self: flex-start;
		font-size: 0.65rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: #b0392c;
		background: #fbd9d5;
		border-radius: 10px;
		padding: 2px 8px;
	}
	.dash-story-title.untitled {
		font-style: italic;
		color: #999;
	}
	.dash-story-title {
		font-size: 0.9rem;
		font-weight: 600;
		color: $text-dark;
		line-height: 1.4;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}
	.dash-story-date {
		font-size: 0.78rem;
		color: $text-light;
	}

	.dash-section-footer {
		text-align: center;
		margin-top: 20px;
	}
	.dash-bank-btn {
		display: inline-block;
		color: $primary;
		font-size: 0.9rem;
		font-weight: 600;
		text-decoration: none;
		padding: 10px 24px;
		border: 1px solid $primary;
		border-radius: 24px;
		transition: all 0.2s;
		&:hover {
			background: $primary;
			color: white;
		}
	}

	.dash-empty {
		background: white;
		border-radius: 12px;
		padding: 32px;
		text-align: center;
		box-shadow: $card-shadow;
		p {
			color: $text-light;
			font-size: 0.9rem;
			margin: 0;
		}
	}

	/* Help link */
	.dash-help-link {
		font-size: 0.85rem;
		color: $text-light;
		cursor: pointer;
		font-weight: 500;
		&:hover {
			color: $text-dark;
			text-decoration: underline;
		}
	}

	/* Modal */
	.modal-overlay {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.4);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 1000;
		padding: 24px;
	}
	.modal-content {
		background: white;
		border-radius: 20px;
		padding: 32px;
		max-width: 480px;
		width: 100%;
		box-shadow: 0 20px 60px rgba(0, 0, 0, 0.15);
	}
	.modal-title {
		font-size: 1.25rem;
		font-weight: 700;
		color: $text-dark;
		margin: 0 0 6px;
	}
	.modal-subtitle {
		font-size: 0.88rem;
		color: $text-light;
		margin: 0 0 24px;
	}
	.modal-label {
		display: block;
		font-size: 0.82rem;
		font-weight: 600;
		color: $text-dark;
		margin-bottom: 6px;
		text-align: left;
	}
	.modal-select {
		display: block;
		width: 100%;
		box-sizing: border-box;
		padding: 10px 44px 10px 14px;
		border: 1px solid #e0dcd6;
		border-radius: 10px;
		font-size: 0.9rem;
		color: $text-dark;
		background: white url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%23666' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E") no-repeat right 16px center;
		margin-bottom: 16px;
		-webkit-appearance: none;
		-moz-appearance: none;
		appearance: none;
		&:focus {
			outline: none;
			border-color: #c96442;
		}
	}
	.modal-textarea {
		display: block;
		width: 100%;
		box-sizing: border-box;
		padding: 12px 14px;
		border: 1px solid #e0dcd6;
		border-radius: 10px;
		font-size: 0.9rem;
		color: $text-dark;
		resize: vertical;
		font-family: inherit;
		line-height: 1.5;
		margin-bottom: 20px;
		&:focus {
			outline: none;
			border-color: #c96442;
		}
		&::placeholder {
			color: #bbb;
		}
	}
	.modal-actions {
		display: flex;
		justify-content: flex-end;
		gap: 10px;
	}
	.modal-cancel {
		padding: 10px 22px;
		border: 1px solid #e0dcd6;
		border-radius: 24px;
		background: white;
		font-size: 0.9rem;
		font-weight: 600;
		color: $text-light;
		cursor: pointer;
		&:hover {
			border-color: #ccc;
			color: $text-dark;
		}
	}
	.modal-submit {
		padding: 10px 26px;
		border: none;
		border-radius: 24px;
		background: #c96442;
		color: white;
		font-size: 0.9rem;
		font-weight: 600;
		cursor: pointer;
		transition: background 0.2s;
		&:hover:not(:disabled) {
			background: #b5593a;
		}
		&:disabled {
			opacity: 0.5;
			cursor: not-allowed;
		}
	}

	/* Success state */
	.modal-success {
		text-align: center;
		padding: 16px 0;
	}
	.modal-success-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 48px;
		height: 48px;
		border-radius: 50%;
		background: #e8f5e9;
		color: #2e7d32;
		font-size: 1.3rem;
		font-weight: 700;
		margin-bottom: 16px;
	}
	.modal-success h3 {
		font-size: 1.15rem;
		font-weight: 700;
		color: $text-dark;
		margin: 0 0 8px;
	}
	.modal-success p {
		font-size: 0.9rem;
		color: $text-light;
		margin: 0 0 24px;
	}
	.modal-close-btn {
		padding: 10px 28px;
		border: 1px solid #e0dcd6;
		border-radius: 24px;
		background: white;
		font-size: 0.9rem;
		font-weight: 600;
		color: $text-dark;
		cursor: pointer;
		&:hover {
			border-color: #ccc;
		}
	}

	/* Responsive */
	@media (max-width: 700px) {
		.dash-cards {
			grid-template-columns: 1fr;
		}
		.dash-stories-grid {
			grid-template-columns: 1fr;
		}
		.dash-greeting h1 {
			font-size: 1.5rem;
		}
	}
</style>
